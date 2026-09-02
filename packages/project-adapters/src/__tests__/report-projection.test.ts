import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DesignSession } from "@design-sharingan/core";
import {
  loadProjectReport,
  redactReportEvidence,
  saveProjectMetadata,
  saveReferenceArtifact,
  saveSession,
} from "../index";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true,
  })));
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "design-sharingan-report-"));
  temporaryRoots.push(root);
  await saveProjectMetadata({
    id: "project-1",
    name: "Report fixture",
    sourceType: "LOCAL",
    rootPath: root,
    status: "READY",
    createdAt: "2026-08-29T12:00:00.000Z",
    updatedAt: "2026-08-29T12:00:00.000Z",
  });
  return root;
}

describe("read-only project report", () => {
  it("redacts secrets and local paths before Git evidence leaves the adapter", () => {
    expect(
      redactReportEvidence(
        "token=super-secret-value\n/Users/example/private/project/.env\nghP_abcdefghijklmnop",
      ),
    ).toBe("[REDACTED] [REDACTED] [REDACTED]");
  });

  it("projects a saved scan with bounded evidence and concrete activity", async () => {
    const root = await projectRoot();
    await saveReferenceArtifact(root, {
      id: "reference-1",
      projectId: "project-1",
      title: "Evidence rail",
      type: "image/png",
      source: "upload",
      likes: [],
      dislikes: [],
      tags: [],
      analysisStatus: "UPLOADED",
      createdAt: "2026-08-29T12:00:00.000Z",
    }, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const session = {
      id: "scan-session-1",
      projectId: "project-1",
      type: "REFERENCE_SCAN" as const,
      status: "ANALYZING" as const,
      createdAt: "2026-08-29T12:00:00.000Z",
      updatedAt: "2026-08-29T12:01:00.000Z",
      referenceId: "reference-1",
      referenceTitle: "Evidence rail",
    };
    await saveSession(root, session);

    const report = await loadProjectReport(root, "project-1", { offset: 0, limit: 25 });

    expect(report.total).toBe(1);
    expect(report.sessions).toEqual([
      expect.objectContaining({
        id: "scan-session-1",
        type: "REFERENCE_SCAN",
        result: "IN_PROGRESS",
        durationMs: 60_000,
        evidence: [
          { kind: "SESSION", id: "scan-session-1", label: "Session record" },
          { kind: "REFERENCE", id: "reference-1", label: "Evidence rail" },
        ],
        filesChanged: [],
        approvals: [],
        visualRounds: 0,
      }),
    ]);
    expect(report.activity.map((event) => event.message)).toEqual([
      "Analyzing reference",
    ]);
  });

  it("fails closed when a stored session is forged or crosses project scope", async () => {
    const root = await projectRoot();
    await writeFile(
      join(root, ".design-sharingan", "sessions", "forged.json"),
      `${JSON.stringify({
        id: "forged",
        projectId: "other-project",
        type: "REFERENCE_SCAN",
        status: "RESULT_READY",
        createdAt: "2026-08-29T12:00:00.000Z",
        updatedAt: "2026-08-29T12:01:00.000Z",
      })}\n`,
      "utf8",
    );

    await expect(loadProjectReport(root, "project-1", { offset: 0, limit: 25 }))
      .rejects.toThrow(/invalid|active project/i);
  });

  it("fails closed when a session record is stored under a different canonical filename", async () => {
    const root = await projectRoot();
    await saveReferenceArtifact(root, {
      id: "reference-1",
      projectId: "project-1",
      title: "Evidence rail",
      type: "image/png",
      source: "upload",
      likes: [],
      dislikes: [],
      tags: [],
      analysisStatus: "UPLOADED",
      createdAt: "2026-08-29T12:00:00.000Z",
    }, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const session = {
      id: "scan-session-1",
      projectId: "project-1",
      type: "REFERENCE_SCAN" as const,
      status: "ANALYZING" as const,
      createdAt: "2026-08-29T12:00:00.000Z",
      updatedAt: "2026-08-29T12:01:00.000Z",
      referenceId: "reference-1",
      referenceTitle: "Evidence rail",
    };
    await writeFile(
      join(root, ".design-sharingan", "sessions", "wrong-file.json"),
      `${JSON.stringify(session)}\n`,
      "utf8",
    );

    await expect(loadProjectReport(root, "project-1", { offset: 0, limit: 25 }))
      .rejects.toThrow(/invalid|filename|identity/i);
  });

  it("fails closed when a scan checkpoint names a missing reference artifact", async () => {
    const root = await projectRoot();
    const session = {
      id: "scan-session-missing-reference",
      projectId: "project-1",
      type: "REFERENCE_SCAN" as const,
      status: "ANALYZING" as const,
      createdAt: "2026-08-29T12:00:00.000Z",
      updatedAt: "2026-08-29T12:01:00.000Z",
      referenceId: "missing-reference",
      referenceTitle: "Missing reference",
    };
    await saveSession(root, session);

    await expect(loadProjectReport(root, "project-1", { offset: 0, limit: 25 }))
      .rejects.toThrow(/reference|artifact|invalid/i);
  });

  // Fix-round probe: a six-field status record is not authenticated
  // governance truth and must never become a successful report row.
  it("rejects a forged governance status-shaped checkpoint", async () => {
    const root = await projectRoot();
    await saveSession(root, {
      id: "gov-forged",
      projectId: "project-1",
      type: "GENOME_INIT",
      status: "APPROVED",
      createdAt: "2026-08-29T12:00:00.000Z",
      updatedAt: "2026-08-29T12:01:00.000Z",
    });

    await expect(loadProjectReport(root, "project-1", { offset: 0, limit: 25 }))
      .rejects.toThrow(/governance|authenticated|authority|checkpoint/i);
  });

  // Fix-round probe: an explicitly durable error must be visible as a
  // failure, not as an apparently healthy ANALYZING session.
  it("projects a durable scan error as FAILED", async () => {
    const root = await projectRoot();
    await saveReferenceArtifact(root, {
      id: "reference-1",
      projectId: "project-1",
      title: "Evidence rail",
      type: "image/png",
      source: "upload",
      likes: [],
      dislikes: [],
      tags: [],
      analysisStatus: "UPLOADED",
      createdAt: "2026-08-29T12:00:00.000Z",
    }, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    await saveSession(root, {
      id: "scan-failed",
      projectId: "project-1",
      type: "REFERENCE_SCAN",
      status: "ANALYZING",
      createdAt: "2026-08-29T12:00:00.000Z",
      updatedAt: "2026-08-29T12:01:00.000Z",
      referenceId: "reference-1",
      referenceTitle: "Evidence rail",
      error: "The analyzer could not read the reference.",
    } as DesignSession & { referenceId: string; referenceTitle: string; error: string });

    const report = await loadProjectReport(root, "project-1", { offset: 0, limit: 25 });
    expect(report.sessions).toEqual([
      expect.objectContaining({ id: "scan-failed", result: "FAILED" }),
    ]);
  });

  // Fix-round probe: ASSIMILATION has no authenticated retained artifact in
  // v0.1, so the projection must be explicit NOT_VERIFIED rather than throw
  // or imply completion.
  it("returns an explicit NOT_VERIFIED fallback for unbound assimilation", async () => {
    const root = await projectRoot();
    await saveSession(root, {
      id: "assimilation-unbound",
      projectId: "project-1",
      type: "ASSIMILATION",
      status: "COMPLETE",
      createdAt: "2026-08-29T12:00:00.000Z",
      updatedAt: "2026-08-29T12:01:00.000Z",
    });

    const report = await loadProjectReport(root, "project-1", { offset: 0, limit: 25 });
    expect(report.sessions).toEqual([
      expect.objectContaining({ id: "assimilation-unbound", result: "NOT_VERIFIED" }),
    ]);
  });
});
