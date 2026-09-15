import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Approval,
  DesignApproach,
  DesignSession,
  FeatureBrief,
} from "@design-sharingan/core";
import {
  loadProjectReport,
  redactReportEvidence,
  saveProjectMetadata,
  saveReferenceArtifact,
  saveSession,
} from "../index";
import type {
  FeatureEvolveApprovedSession,
  SafeExecutionDraftSession,
} from "../index";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

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

const featureBrief: FeatureBrief = {
  name: "Evidence inbox",
  goal: "Triage unresolved design evidence.",
  description: "Add a bounded evidence inbox.",
  constraints: ["Keep navigation"],
  mustKeep: ["Reports history"],
  mustNotChange: ["No new route"],
  successCriteria: ["Triage one item quickly"],
};

const designApproach: DesignApproach = {
  id: "approach-guided-queue",
  title: "Guided evidence queue",
  summary: "Add a bounded queue in the current screen.",
  recommended: true,
  pros: ["Preserves navigation"],
  cons: ["Adds one state"],
  uxImpact: [{
    area: "Reference review",
    severity: "IMPORTANT",
    reason: "Review state becomes explicit.",
    affectedRoutes: ["/references"],
    affectedComponents: ["ReferenceCard"],
    decisionRequired: true,
  }],
  estimatedComplexity: "MEDIUM",
  genomeFit: "Fits the evidence-first direction.",
  likelyFiles: ["src/reference-card.tsx"],
  status: "PROPOSED",
};

function approvedFeatureAndSafe(
  suffix: string,
  sourceCreatedAt: string,
  approvedAt: string,
): {
  feature: FeatureEvolveApprovedSession;
  safe: SafeExecutionDraftSession;
} {
  const approval: Approval = {
    id: `approval-${suffix}`,
    proposalId: designApproach.id,
    decision: "APPROVED",
    scope: "DESIGN_APPROACH",
    approvedBy: "local-user",
    createdAt: approvedAt,
  };
  const feature = {
    id: `feature-${suffix}`,
    projectId: "project-1",
    type: "FEATURE_EVOLVE" as const,
    status: "APPROVED" as const,
    createdAt: sourceCreatedAt,
    updatedAt: approvedAt,
    featureBrief,
    referenceIds: [],
    uxImpact: designApproach.uxImpact,
    approaches: [
      designApproach,
      {
        ...designApproach,
        id: `approach-${suffix}-alternate`,
        title: "Inline evidence markers",
        recommended: false,
      },
    ],
    agentThreadId: `thread-${suffix}`,
    approvedApproachId: designApproach.id,
    approval,
    executeSessionId: `safe-${suffix}`,
  };
  const safe = {
    id: feature.executeSessionId,
    projectId: "project-1",
    type: "SAFE_EXECUTION" as const,
    status: "IDLE" as const,
    createdAt: approvedAt,
    updatedAt: approvedAt,
    sourceSessionId: feature.id,
    approvedApproachId: designApproach.id,
    approvalId: approval.id,
    featureBrief,
    designApproach,
  };
  return { feature, safe };
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

  it("authenticates only an approved Feature row's exact off-page Safe relation", async () => {
    const root = await projectRoot();
    const selected = approvedFeatureAndSafe(
      "selected",
      "2026-08-29T13:00:00.000Z",
      "2026-08-29T14:00:00.000Z",
    );
    const unrelated = approvedFeatureAndSafe(
      "unrelated",
      "2026-08-29T10:00:00.000Z",
      "2026-08-29T11:00:00.000Z",
    );
    await saveSession(root, selected.feature);
    await saveSession(root, selected.safe);
    await saveSession(root, unrelated.feature);
    await saveSession(root, unrelated.safe);

    // Retain the authenticated head index but make an unrelated off-page Safe
    // body unreadable. A bounded relation lookup must open only safe-selected.
    await writeFile(
      join(root, ".design-sharingan", "sessions", "safe-unrelated.json"),
      "{ deliberately malformed unrelated Safe body\n",
      "utf8",
    );

    vi.mocked(open).mockClear();
    const report = await loadProjectReport(
      root,
      "project-1",
      { offset: 1, limit: 1 },
    );
    expect(report).toMatchObject({
      total: 4,
      sessions: [{
        id: "feature-selected",
        result: "APPROVED",
        evidence: expect.arrayContaining([
          expect.objectContaining({ kind: "SESSION", id: "safe-selected" }),
        ]),
      }],
    });
    const openedSessionBodies = vi.mocked(open).mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.includes("/.design-sharingan/sessions/") && path.endsWith(".json"));
    expect(openedSessionBodies.map((path) => basename(path))).toEqual([
      "feature-selected.json",
      "safe-selected.json",
    ]);
  });

  it("fails closed when an approved Feature row's exact Safe relation is missing", async () => {
    const root = await projectRoot();
    const { feature } = approvedFeatureAndSafe(
      "missing",
      "2026-08-29T13:00:00.000Z",
      "2026-08-29T14:00:00.000Z",
    );
    await saveSession(root, feature);

    await expect(
      loadProjectReport(root, "project-1", { offset: 0, limit: 1 }),
    ).rejects.toThrow(/safe|session|missing|ENOENT/i);
  });

  it("fails closed when an approved Feature row's exact Safe relation is forged", async () => {
    const root = await projectRoot();
    const { feature, safe } = approvedFeatureAndSafe(
      "forged",
      "2026-08-29T13:00:00.000Z",
      "2026-08-29T14:00:00.000Z",
    );
    await saveSession(root, feature);
    const forgedSafe: SafeExecutionDraftSession = {
      ...safe,
      approvalId: "approval-substituted",
    };
    await saveSession(root, forgedSafe);

    await expect(
      loadProjectReport(root, "project-1", { offset: 1, limit: 1 }),
    ).rejects.toThrow(/safe|approval|source|evidence|match/i);
  });

  it("fails closed when selected Feature rows claim the same Safe relation", async () => {
    const root = await projectRoot();
    const first = approvedFeatureAndSafe(
      "first",
      "2026-08-29T13:00:00.000Z",
      "2026-08-29T14:00:00.000Z",
    );
    const second = approvedFeatureAndSafe(
      "second",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T14:00:00.000Z",
    );
    await saveSession(root, first.feature);
    await saveSession(root, first.safe);
    const conflictingFeature: FeatureEvolveApprovedSession = {
      ...second.feature,
      executeSessionId: first.safe.id,
    };
    await saveSession(root, conflictingFeature);

    await expect(
      loadProjectReport(root, "project-1", { offset: 1, limit: 2 }),
    ).rejects.toThrow(/authenticated Safe execution|source|evidence/i);
  });

  it("pages before opening off-page reference artifacts across hundreds of indexed sessions", async () => {
    const root = await projectRoot();
    for (let index = 0; index < 200; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 7, 29, 12, 0, index)).toISOString();
      await saveSession(root, {
        id: `scan-history-${index.toString().padStart(3, "0")}`,
        projectId: "project-1",
        type: "REFERENCE_SCAN",
        status: "ANALYZING",
        createdAt: timestamp,
        updatedAt: timestamp,
        referenceId: `missing-reference-${index}`,
        referenceTitle: `Off-page reference ${index}`,
      } as DesignSession & { referenceId: string; referenceTitle: string });
    }
    await saveReferenceArtifact(root, {
      id: "reference-visible",
      projectId: "project-1",
      title: "Visible page evidence",
      type: "image/png",
      source: "upload",
      likes: [],
      dislikes: [],
      tags: [],
      analysisStatus: "UPLOADED",
      createdAt: "2026-08-29T13:00:00.000Z",
    }, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    await saveSession(root, {
      id: "scan-visible",
      projectId: "project-1",
      type: "REFERENCE_SCAN",
      status: "ANALYZING",
      createdAt: "2026-08-29T13:00:00.000Z",
      updatedAt: "2026-08-29T13:00:00.000Z",
      referenceId: "reference-visible",
      referenceTitle: "Visible page evidence",
    } as DesignSession & { referenceId: string; referenceTitle: string });

    await expect(
      loadProjectReport(root, "project-1", { offset: 0, limit: 1 }),
    ).resolves.toMatchObject({
      total: 201,
      sessions: [{ id: "scan-visible" }],
    });
    // The page index must not open an unrelated retained body. A malformed
    // old record remains a problem when selected, but cannot turn a visible
    // page into an unbounded full-history read.
    await writeFile(
      join(root, ".design-sharingan", "sessions", "scan-history-000.json"),
      "{ deliberately malformed off-page session body\n",
      "utf8",
    );
    await expect(
      loadProjectReport(root, "project-1", { offset: 0, limit: 1 }),
    ).resolves.toMatchObject({
      total: 201,
      sessions: [{ id: "scan-visible" }],
    });
    await expect(
      loadProjectReport(root, "project-1", { offset: 200, limit: 1 }),
    ).rejects.toThrow(/reference|artifact|invalid|json/i);
  }, 60_000);

  it("rejects oversized reference-id arrays before persistence", async () => {
    const root = await projectRoot();
    const id = "oversized-reference-array";
    await expect(saveSession(root, {
      id,
      projectId: "project-1",
      type: "ASSIMILATION",
      status: "DRAFT",
      createdAt: "2026-08-29T12:00:00.000Z",
      updatedAt: "2026-08-29T12:00:00.000Z",
      referenceIds: Array.from({ length: 33 }, (_, index) => `reference-${index}`),
    } as DesignSession & { referenceIds: string[] })).rejects.toThrow(/reference.*bound|reference.*32/i);
    await expect(lstat(join(root, ".design-sharingan", "sessions", `${id}.json`)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
