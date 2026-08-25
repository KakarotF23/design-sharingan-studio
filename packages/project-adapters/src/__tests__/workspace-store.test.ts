import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  DesignDNA,
  DesignSession,
  Project,
  Reference,
  RenderArtifact,
} from "@design-sharingan/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureDesignWorkspace,
  listReferences,
  listSessions,
  loadReference,
  loadReferenceImage,
  loadReferenceDesignDNA,
  loadProjectMetadata,
  saveReferenceDesignDNA,
  saveGuardedProjectMetadata,
  saveProjectMetadata,
  saveReferenceArtifact,
  saveRenderArtifact,
  saveSession,
  updateReference,
  validateReferenceImage,
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

// Production break caught: a route reload must be able to recover the
// persisted project without creating missing runtime directories as a side
// effect of a read.
it("loads validated project metadata without creating workspace state", async () => {
  const rootPath = await realpath(await temporaryProject());
  const machinePath = join(rootPath, ".design-sharingan");
  await mkdir(machinePath);
  await writeFile(
    join(machinePath, "project.json"),
    `${JSON.stringify(projectFixture(rootPath))}\n`,
  );

  await expect(loadProjectMetadata(rootPath, "project-1")).resolves.toEqual(
    projectFixture(rootPath),
  );
  await expect(lstat(join(machinePath, "references"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

// Production break caught: a cookie locator is only a locator; persisted
// metadata still has to bind the requested id and canonical root exactly.
it.each([
  ["a mismatched project id", { id: "another-project" }],
  ["a mismatched canonical root", { rootPath: "/private/tmp/not-this-project" }],
] as const)("rejects %s while loading project metadata", async (_label, change) => {
  const rootPath = await realpath(await temporaryProject());
  const machinePath = join(rootPath, ".design-sharingan");
  await mkdir(machinePath);
  await writeFile(
    join(machinePath, "project.json"),
    `${JSON.stringify({ ...projectFixture(rootPath), ...change })}\n`,
  );

  await expect(loadProjectMetadata(rootPath, "project-1")).rejects.toThrow(
    /active project identity/i,
  );
});

// Production break caught: reading through a project.json symlink makes the
// active project identity depend on another filesystem location.
it("rejects symlinked project metadata without creating workspace state", async () => {
  const rootPath = await realpath(await temporaryProject());
  const machinePath = join(rootPath, ".design-sharingan");
  const sourcePath = join(rootPath, "source-project.json");
  await mkdir(machinePath);
  await writeFile(sourcePath, `${JSON.stringify(projectFixture(rootPath))}\n`);
  await symlink(sourcePath, join(machinePath, "project.json"));

  await expect(loadProjectMetadata(rootPath, "project-1")).rejects.toThrow(
    /symbolic link|active project identity/i,
  );
  expect(await readFile(sourcePath, "utf8")).toContain('"project-1"');
});

// Production break caught: an ownership token bound only to an ancestor can
// authorize a workspace outside the adapter's exact allocation parent.
it("rejects guarded ownership whose parent is not the root's exact parent", async () => {
  const allocationParent = await realpath(await temporaryProject());
  const rootPath = join(allocationParent, "owned-workspace");
  await mkdir(rootPath);
  const rootEntry = await stat(rootPath);

  await expect(
    saveGuardedProjectMetadata(projectFixture(rootPath), {
      rootPath,
      parentPath: dirname(allocationParent),
      dev: rootEntry.dev,
      ino: rootEntry.ino,
    }),
  ).rejects.toThrow(/owned workspace identity changed/i);

  await expect(lstat(join(rootPath, ".design-sharingan"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

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

const validPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);

function designDNAFixture(): DesignDNA {
  return {
    id: "dna-1",
    referenceIds: ["reference-1"],
    hierarchy: ["Clear hierarchy"],
    layout: ["Split evidence and interpretation"],
    spacing: ["Wide sections"],
    typography: ["Condensed display"],
    colorLogic: ["Neutral with a restrained accent"],
    componentGeometry: ["Square technical panels"],
    navigation: ["Stable project rail"],
    interaction: ["Explicit primary action"],
    motion: ["Reserved for progress"],
    density: ["Dense evidence, spacious summary"],
    emotionalTone: ["Calm and technical"],
    visualWeight: ["Reference balanced by decisions"],
    keep: ["Clear hierarchy"],
    reject: ["Branded artwork"],
    adapt: ["Use the product accent"],
    invent: ["Add a product-fit trail"],
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

// Production break caught: canonical containment alone lets the machine root alias the project root and redirect session writes into source.
it("rejects an in-project machine-root symlink alias without replacing source", async () => {
  const rootPath = await temporaryProject();
  const sourceSessionPath = join(rootPath, "sessions", "session-1.json");
  await mkdir(dirname(sourceSessionPath), { recursive: true });
  await writeFile(sourceSessionPath, "source-owned\n");
  await symlink(".", join(rootPath, ".design-sharingan"));

  const result = await saveSession(rootPath, sessionFixture()).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(await readFile(sourceSessionPath, "utf8")).toBe("source-owned\n");
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toMatch(/symbolic link/i);
});

// Production break caught: any fixed runtime-directory alias can redirect machine artifacts into an in-project source directory.
it.each(["references", "sessions", "renders", "cache"])(
  "rejects a symbolic-link alias for the fixed %s directory",
  async (directoryName) => {
    const rootPath = await temporaryProject();
    const workspace = await ensureDesignWorkspace(rootPath);
    const fixedPath = join(workspace.machinePath, directoryName);
    const aliasTarget = join(rootPath, `source-${directoryName}`);
    await rm(fixedPath, { recursive: true });
    await mkdir(aliasTarget);
    await symlink(aliasTarget, fixedPath);

    await expect(ensureDesignWorkspace(rootPath)).rejects.toThrow(/symbolic link/i);
  },
);

// Production break caught: accepting project.json as a symlink allows workspace identity to alias another in-project file.
it("rejects a symbolic-link alias for project metadata", async () => {
  const rootPath = await temporaryProject();
  const workspace = await ensureDesignWorkspace(rootPath);
  const sourcePath = join(rootPath, "source-project.json");
  await rm(workspace.projectMetadataPath);
  await writeFile(sourcePath, '{"sourceOwned":true}\n');
  await symlink(sourcePath, workspace.projectMetadataPath);

  await expect(ensureDesignWorkspace(rootPath)).rejects.toThrow(/symbolic link/i);
  expect(await readFile(sourcePath, "utf8")).toBe('{"sourceOwned":true}\n');
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
  await saveProjectMetadata(projectFixture(rootPath));

  const saved = await saveReferenceArtifact(
    rootPath,
    referenceFixture(),
    validPng,
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
    validPng,
  );
  expect(JSON.parse(await readFile(saved.metadataPath, "utf8"))).toMatchObject({
    id: "reference-1",
    imagePath: saved.artifactPath,
  });
});

// Production break caught: trusting an extension or browser-declared media type lets SVG, empty, oversized, or disguised content enter the visual-analysis boundary.
it("accepts only bounded raster references whose signature matches the declared MIME", () => {
  expect(validateReferenceImage("image/png", validPng)).toBe(".png");
  expect(
    validateReferenceImage(
      "image/jpeg",
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    ),
  ).toBe(".jpg");
  expect(
    validateReferenceImage(
      "image/webp",
      new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      ]),
    ),
  ).toBe(".webp");
  expect(
    validateReferenceImage(
      "image/gif",
      new TextEncoder().encode("GIF89a"),
    ),
  ).toBe(".gif");

  expect(() => validateReferenceImage("image/png", new Uint8Array())).toThrow(
    /empty/i,
  );
  expect(() => validateReferenceImage("image/jpeg", validPng)).toThrow(
    /signature/i,
  );
  expect(() =>
    validateReferenceImage(
      "image/svg+xml",
      new TextEncoder().encode("<svg></svg>"),
    ),
  ).toThrow(/PNG, JPEG, WebP, or GIF/i);
  expect(() =>
    validateReferenceImage("image/png", new Uint8Array(10 * 1024 * 1024 + 1)),
  ).toThrow(/10 MiB/i);
});

// Production break caught: write-only reference/session helpers make the References, Learn, and Reports workspaces lose durable state after navigation or reload.
it("reads, lists, updates, and attaches DesignDNA to durable reference and session records", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const saved = await saveReferenceArtifact(
    rootPath,
    referenceFixture(),
    validPng,
  );
  const updated = {
    ...(await loadReference(rootPath, "project-1", "reference-1")),
    imagePath: saved.artifactPath,
    notes: "Preserve the hierarchy.",
    likes: ["Clear hierarchy"],
    dislikes: ["Decoration"],
    analysisStatus: "ANALYZED" as const,
  };

  await updateReference(rootPath, updated);
  await saveReferenceDesignDNA(
    rootPath,
    "project-1",
    "reference-1",
    designDNAFixture(),
  );
  await saveSession(rootPath, sessionFixture());

  await expect(listReferences(rootPath, "project-1")).resolves.toEqual([
    updated,
  ]);
  await expect(
    loadReferenceImage(rootPath, "project-1", "reference-1"),
  ).resolves.toEqual({ bytes: validPng, type: "image/png" });
  await expect(
    loadReferenceDesignDNA(rootPath, "project-1", "reference-1"),
  ).resolves.toEqual(designDNAFixture());
  await expect(listSessions(rootPath, "project-1")).resolves.toEqual([
    sessionFixture(),
  ]);
  expect(new Uint8Array(await readFile(saved.artifactPath))).toEqual(validPng);
});

// Production break caught: an explicit root alone permits a reference from another project to be written into the active workspace.
it("rejects a reference whose project identity does not match the workspace", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const mismatchedReference = {
    ...referenceFixture(),
    projectId: "project-2",
  };

  const result = await saveReferenceArtifact(
    rootPath,
    mismatchedReference,
    new Uint8Array([1]),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );

  await expect(
    lstat(
      join(
        rootPath,
        ".design-sharingan",
        "references",
        mismatchedReference.id,
      ),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toMatch(/active project identity/i);
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
  await saveProjectMetadata(projectFixture(rootPath));

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

// Production break caught: an explicit root alone permits a session from another project to be written into the active workspace.
it("rejects a session whose project identity does not match the workspace", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const mismatchedSession = {
    ...sessionFixture(),
    projectId: "project-2",
  };

  const result = await saveSession(rootPath, mismatchedSession).then(
    () => undefined,
    (error: unknown) => error,
  );

  await expect(
    lstat(
      join(
        rootPath,
        ".design-sharingan",
        "sessions",
        `${mismatchedSession.id}.json`,
      ),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toMatch(/active project identity/i);
});

// Production break caught: missing persisted identity must not default to trusting the caller's project id.
it.each(["reference", "session"] as const)(
  "fails closed when saving a %s without validated project metadata",
  async (artifactKind) => {
    const rootPath = await temporaryProject();
    await ensureDesignWorkspace(rootPath);

    const result =
      artifactKind === "reference"
        ? await saveReferenceArtifact(
            rootPath,
            referenceFixture(),
            new Uint8Array([1]),
          ).then(
            () => undefined,
            (error: unknown) => error,
          )
        : await saveSession(rootPath, sessionFixture()).then(
            () => undefined,
            (error: unknown) => error,
          );

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/active project identity/i);
  },
);

// Production break caught: a failed replacement that leaves temp files behind pollutes runtime state and can be mistaken for evidence.
it("cleans its temporary JSON file when atomic replacement fails", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
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
