import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignSession, Project } from "@design-sharingan/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  listSessions,
  saveProjectMetadata,
  saveSession,
} from "../workspace-store";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const actualFileSystem = await vi.importActual<typeof import("node:fs/promises")>(
  "node:fs/promises",
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.mocked(open).mockImplementation(actualFileSystem.open);
  await Promise.all(
    temporaryRoots.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

it("retries an authenticated session read when a writer publishes between its checkpoint and head reads", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "design-sharingan-read-race-"));
  temporaryRoots.push(rootPath);
  const project: Project = {
    id: "project-1",
    name: "Fixture",
    sourceType: "LOCAL",
    rootPath,
    status: "READY",
    createdAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
  };
  const original: DesignSession = {
    id: "session-race",
    projectId: project.id,
    type: "REFERENCE_SCAN",
    status: "DRAFT",
    createdAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
  };
  const updated: DesignSession = {
    ...original,
    status: "ANALYZING",
    updatedAt: "2026-08-24T10:00:01.000Z",
  };
  await saveProjectMetadata(project);
  await saveSession(rootPath, original);

  let resumeHeadRead!: () => void;
  const mayReadHead = new Promise<void>((resolve) => { resumeHeadRead = resolve; });
  let reportHeadRead!: () => void;
  const headReadStarted = new Promise<void>((resolve) => { reportHeadRead = resolve; });
  let paused = false;
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    if (
      !paused &&
      String(path).endsWith("/.design-sharingan/activity/session-race.session-head.json")
    ) {
      paused = true;
      reportHeadRead();
      await mayReadHead;
    }
    return actualFileSystem.open(path, flags, mode);
  });

  const reading = listSessions(rootPath, project.id);
  await headReadStarted;
  await saveSession(rootPath, updated);
  resumeHeadRead();

  await expect(reading).resolves.toEqual([updated]);
});

it("still rejects a persistently unauthenticated session head after bounded retries", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "design-sharingan-read-tamper-"));
  temporaryRoots.push(rootPath);
  const project: Project = {
    id: "project-1",
    name: "Fixture",
    sourceType: "LOCAL",
    rootPath,
    status: "READY",
    createdAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
  };
  const session: DesignSession = {
    id: "session-forged-head",
    projectId: project.id,
    type: "REFERENCE_SCAN",
    status: "DRAFT",
    createdAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
  };
  await saveProjectMetadata(project);
  await saveSession(rootPath, session);
  const headPath = join(
    rootPath,
    ".design-sharingan",
    "activity",
    `${session.id}.session-head.json`,
  );
  const head = JSON.parse(await readFile(headPath, "utf8")) as Record<string, unknown>;
  await writeFile(
    headPath,
    `${JSON.stringify({ ...head, eventId: `act_${"0".repeat(64)}` })}\n`,
  );

  await expect(listSessions(rootPath, project.id)).rejects.toThrow(
    /not authenticated by its immutable checkpoint/i,
  );
});
