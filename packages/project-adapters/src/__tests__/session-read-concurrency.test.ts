import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignSession, Project } from "@design-sharingan/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  listSessions,
  saveProjectMetadata,
  saveSession,
  setSessionCommitFaultForTest,
  setSessionRecoveryHookForTest,
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
  setSessionCommitFaultForTest(undefined);
  setSessionRecoveryHookForTest(undefined);
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

it("retries only when a completed writer's event was absent from the reader snapshot", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "design-sharingan-event-gap-"));
  temporaryRoots.push(rootPath);
  const project: Project = {
    id: "project-1", name: "Fixture", sourceType: "LOCAL", rootPath, status: "READY",
    createdAt: "2026-08-24T09:00:00.000Z", updatedAt: "2026-08-24T10:00:00.000Z",
  };
  const original: DesignSession = {
    id: "session-event-gap", projectId: project.id, type: "REFERENCE_SCAN", status: "DRAFT",
    createdAt: "2026-08-24T09:00:00.000Z", updatedAt: "2026-08-24T10:00:00.000Z",
  };
  const updated: DesignSession = {
    ...original, status: "ANALYZING", updatedAt: "2026-08-24T10:00:01.000Z",
  };
  await saveProjectMetadata(project);
  await saveSession(rootPath, original);

  let resumeEventCreate!: () => void;
  let eventCreatePaused!: () => void;
  const mayCreateEvent = new Promise<void>((resolve) => { resumeEventCreate = resolve; });
  const eventCreateStarted = new Promise<void>((resolve) => { eventCreatePaused = resolve; });
  let pausedEvent = false;
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const name = String(path);
    if (
      !pausedEvent && name.includes("/.design-sharingan/activity/.act_") &&
      !name.includes(".checkpoint") && flags === "wx"
    ) {
      pausedEvent = true;
      eventCreatePaused();
      await mayCreateEvent;
    }
    return actualFileSystem.open(path, flags, mode);
  });

  let resumeReader!: () => void;
  let readerSnapshotCaptured!: () => void;
  const mayResumeReader = new Promise<void>((resolve) => { resumeReader = resolve; });
  const readerSnapshot = new Promise<void>((resolve) => { readerSnapshotCaptured = resolve; });
  setSessionRecoveryHookForTest(async () => {
    if (!pausedEvent) return;
    readerSnapshotCaptured();
    await mayResumeReader;
  });
  const writing = saveSession(rootPath, updated);
  await eventCreateStarted;
  const reading = listSessions(rootPath, project.id);
  await readerSnapshot;
  resumeEventCreate();
  await writing;
  resumeReader();

  await expect(reading).resolves.toEqual([updated]);
}, 15_000);

it("keeps a persistently missing future activity event fail-closed", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "design-sharingan-missing-event-"));
  temporaryRoots.push(rootPath);
  const project: Project = {
    id: "project-1", name: "Fixture", sourceType: "LOCAL", rootPath, status: "READY",
    createdAt: "2026-08-24T09:00:00.000Z", updatedAt: "2026-08-24T10:00:00.000Z",
  };
  const original: DesignSession = {
    id: "session-missing-event", projectId: project.id, type: "REFERENCE_SCAN", status: "DRAFT",
    createdAt: "2026-08-24T09:00:00.000Z", updatedAt: "2026-08-24T10:00:00.000Z",
  };
  const updated: DesignSession = {
    ...original, status: "ANALYZING", updatedAt: "2026-08-24T10:00:01.000Z",
  };
  await saveProjectMetadata(project);
  await saveSession(rootPath, original);
  setSessionCommitFaultForTest("after-journal-before-session");
  await expect(saveSession(rootPath, updated)).rejects.toThrow(/injected session commit crash/i);
  setSessionCommitFaultForTest(undefined);
  await writeFile(
    join(rootPath, ".design-sharingan", "sessions", `${updated.id}.json`),
    `${JSON.stringify(updated)}\n`,
  );
  const activityPath = join(rootPath, ".design-sharingan", "activity");
  // Keep the old event but remove the future one selected by its newer checkpoint.
  const records = await Promise.all((await actualFileSystem.readdir(activityPath))
    .filter((name) => name.endsWith(".checkpoint.json"))
    .map(async (name) => ({
      name,
      value: JSON.parse(await readFile(join(activityPath, name), "utf8")) as { version: number; eventId: string },
    })));
  const newest = records.sort((left, right) => right.value.version - left.value.version)[0];
  if (newest === undefined) throw new Error("Future checkpoint fixture was not created");
  await actualFileSystem.unlink(join(activityPath, `${newest.value.eventId}.json`));

  await expect(listSessions(rootPath, project.id)).rejects.toThrow(
    /future session checkpoint cannot be recovered without its activity event/i,
  );
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
