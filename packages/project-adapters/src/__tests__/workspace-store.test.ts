import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DesignSession,
  Project,
  Reference,
  RenderArtifact,
} from "@design-sharingan/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureDesignWorkspace,
  saveProjectMetadata,
  saveReferenceArtifact,
  saveRenderArtifact,
  saveSession,
} from "../workspace-store";

const temporaryRoots: string[] = [];

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "design-sharingan-store-"));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryRoots.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

function projectFixture(rootPath: string): Project {
  return {
    updatedAt: "2026-08-24T10:00:00.000Z",
    status: "READY",
    sourceType: "LOCAL",
    rootPath,
    name: "Fixture",
    id: "project-1",
    createdAt: "2026-08-24T09:00:00.000Z",
  };
}

function referenceFixture(): Reference {
  return {
    id: "reference-1",
    projectId: "project-1",
    title: "Reference",
    type: "image/png",
    source: "upload",
    likes: [],
    dislikes: [],
    tags: [],
    analysisStatus: "UPLOADED",
    createdAt: "2026-08-24T09:00:00.000Z",
  };
}

function sessionFixture(id = "session-1"): DesignSession {
  return {
    id,
    projectId: "project-1",
    type: "REFERENCE_SCAN",
    status: "DRAFT",
    createdAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
  };
}

// Production break caught: omitting a runtime directory or creating governance makes machine state incomplete or falsely authoritative.
it("creates only the machine workspace layout and no governance truth", async () => {
  const rootPath = await temporaryProject();

  const workspace = await ensureDesignWorkspace(rootPath);

  expect((await stat(workspace.projectMetadataPath)).isFile()).toBe(true);
  expect((await stat(workspace.referencesPath)).isDirectory()).toBe(true);
  expect((await stat(workspace.sessionsPath)).isDirectory()).toBe(true);
  expect((await stat(workspace.rendersPath)).isDirectory()).toBe(true);
  expect((await stat(workspace.cachePath)).isDirectory()).toBe(true);
  await expect(lstat(join(rootPath, "design-governance"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

// Production break caught: accepting a directory named project.json leaves the required metadata file unavailable.
it("fails closed when project metadata is not a regular file", async () => {
  const rootPath = await temporaryProject();
  await mkdir(join(rootPath, ".design-sharingan", "project.json"), {
    recursive: true,
  });

  await expect(ensureDesignWorkspace(rootPath)).rejects.toThrow(/regular file/i);
});

// Production break caught: non-stable serialization or in-place writes produce noisy metadata and expose partial files to readers.
it("writes stable two-space JSON by atomic file replacement", async () => {
  const rootPath = await temporaryProject();
  await ensureDesignWorkspace(rootPath);
  const metadataPath = await saveProjectMetadata(projectFixture(rootPath));
  const firstInode = (await stat(metadataPath)).ino;

  const updatedProject = {
    ...projectFixture(rootPath),
    name: "Updated Fixture",
  };
  await saveProjectMetadata(updatedProject);

  expect((await stat(metadataPath)).ino).not.toBe(firstInode);
  expect(await readFile(metadataPath, "utf8")).toBe(
    `${JSON.stringify(
      {
        createdAt: "2026-08-24T09:00:00.000Z",
        id: "project-1",
        name: "Updated Fixture",
        rootPath,
        sourceType: "LOCAL",
        status: "READY",
        updatedAt: "2026-08-24T10:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );
  expect((await readdir(join(rootPath, ".design-sharingan"))).some((name) =>
    name.includes(".tmp-"),
  )).toBe(false);
});

// Production break caught: artifact persistence that stores only bytes loses the domain record and actual image location.
it("persists a reference record and bytes under its reference directory", async () => {
  const rootPath = await temporaryProject();
  await ensureDesignWorkspace(rootPath);

  const saved = await saveReferenceArtifact(
    rootPath,
    referenceFixture(),
    new Uint8Array([137, 80, 78, 71]),
  );
  const canonicalRoot = await realpath(rootPath);

  expect(saved.artifactPath).toBe(
    join(
      canonicalRoot,
      ".design-sharingan",
      "references",
      "reference-1",
      "artifact.png",
    ),
  );
  expect(new Uint8Array(await readFile(saved.artifactPath))).toEqual(
    new Uint8Array([137, 80, 78, 71]),
  );
  expect(JSON.parse(await readFile(saved.metadataPath, "utf8"))).toMatchObject({
    id: "reference-1",
    imagePath: saved.artifactPath,
  });
});

// Production break caught: trusting a session id as a path segment lets persistence escape its artifact directory.
it("rejects a session id that traverses outside machine state", async () => {
  const rootPath = await temporaryProject();
  await ensureDesignWorkspace(rootPath);

  await expect(saveSession(rootPath, sessionFixture("../../escaped"))).rejects.toThrow(
    /outside active project|safe path segment/i,
  );
  await expect(lstat(join(rootPath, "escaped.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

// Production break caught: omitting the final rename leaves a session unavailable at its durable path.
it("persists a session record at its stable machine-state path", async () => {
  const rootPath = await temporaryProject();

  const sessionPath = await saveSession(rootPath, sessionFixture());

  expect(sessionPath).toBe(
    join(
      await realpath(rootPath),
      ".design-sharingan",
      "sessions",
      "session-1.json",
    ),
  );
  expect(JSON.parse(await readFile(sessionPath, "utf8"))).toEqual(
    sessionFixture(),
  );
});

// Production break caught: a failed replacement that leaves temp files behind pollutes runtime state and can be mistaken for evidence.
it("cleans its temporary JSON file when atomic replacement fails", async () => {
  const rootPath = await temporaryProject();
  await ensureDesignWorkspace(rootPath);
  const sessionsPath = join(rootPath, ".design-sharingan", "sessions");
  await mkdir(join(sessionsPath, "blocked.json"));

  await expect(saveSession(rootPath, sessionFixture("blocked"))).rejects.toThrow();

  expect((await readdir(sessionsPath)).filter((name) => name.includes(".tmp-"))).toEqual(
    [],
  );
});

// Production break caught: trusting render imagePath allows the evidence store to overwrite project source or outside files.
it("persists render bytes only inside the runtime renders directory", async () => {
  const rootPath = await temporaryProject();
  await ensureDesignWorkspace(rootPath);
  const validMetadata: RenderArtifact = {
    id: "render-1",
    sessionId: "session-1",
    route: "/",
    viewport: "desktop",
    imagePath: join(
      rootPath,
      ".design-sharingan",
      "renders",
      "session-1",
      "round-1",
      "desktop.png",
    ),
    capturedAt: "2026-08-24T10:00:00.000Z",
  };

  const saved = await saveRenderArtifact(
    rootPath,
    validMetadata,
    new Uint8Array([137, 80, 78, 71]),
  );
  expect(new Uint8Array(await readFile(saved.artifactPath))).toEqual(
    new Uint8Array([137, 80, 78, 71]),
  );
  expect(JSON.parse(await readFile(saved.metadataPath, "utf8"))).toEqual({
    ...validMetadata,
    imagePath: join(
      await realpath(rootPath),
      ".design-sharingan",
      "renders",
      "session-1",
      "round-1",
      "desktop.png",
    ),
  });

  await expect(
    saveRenderArtifact(
      rootPath,
      { ...validMetadata, imagePath: join(rootPath, "src", "overwritten.png") },
      new Uint8Array([1]),
    ),
  ).rejects.toThrow(/outside active project/i);
});
