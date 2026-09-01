import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listActivityEvents,
  saveProjectMetadata,
  saveSession,
} from "../workspace-store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true,
  })));
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "design-sharingan-activity-"));
  temporaryRoots.push(root);
  await saveProjectMetadata({
    id: "project-1",
    name: "Activity fixture",
    sourceType: "LOCAL",
    rootPath: root,
    status: "READY",
    createdAt: "2026-08-29T12:00:00.000Z",
    updatedAt: "2026-08-29T12:00:00.000Z",
  });
  return root;
}

describe("durable workflow activity", () => {
  it("persists one concrete event for a retried durable session checkpoint", async () => {
    const root = await projectRoot();
    const session = {
      id: "scan-session-1",
      projectId: "project-1",
      type: "REFERENCE_SCAN" as const,
      status: "ANALYZING",
      createdAt: "2026-08-29T12:00:00.000Z",
      updatedAt: "2026-08-29T12:01:00.000Z",
      referenceId: "reference-1",
      referenceTitle: "Evidence rail",
    };

    await saveSession(root, session);
    await saveSession(root, session);

    const events = await listActivityEvents(root, "project-1");
    expect(events).toEqual([
      expect.objectContaining({
        sessionId: "scan-session-1",
        category: "AGENT",
        message: "Analyzing reference",
        occurredAt: "2026-08-29T12:01:00.000Z",
        evidence: [{ kind: "SESSION", id: "scan-session-1" }],
      }),
    ]);
    expect(Object.isFrozen(events[0])).toBe(true);
  });

  it("keeps adjacent Safe Mode checkpoints concrete instead of duplicating a retry label", async () => {
    const root = await projectRoot();
    const base = {
      id: "safe-session-1",
      projectId: "project-1",
      type: "SAFE_EXECUTION" as const,
      createdAt: "2026-08-29T12:00:00.000Z",
      sourceSessionId: "feature-session-1",
      approvedApproachId: "approach-1",
      approvalId: "approval-1",
    };

    await saveSession(root, {
      ...base,
      status: "PREPARING",
      updatedAt: "2026-08-29T12:00:01.000Z",
    });
    await saveSession(root, {
      ...base,
      status: "PROPOSING",
      updatedAt: "2026-08-29T12:00:02.000Z",
    });

    const events = await listActivityEvents(root, "project-1");
    expect(events.map(({ message }) => message)).toEqual([
      "Change proposal ready",
      "Preparing change proposal",
    ]);
  });
});
