import {
  chmod,
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
  Approval,
  DesignApproach,
  DesignDNA,
  DesignSession,
  FeatureBrief,
  Project,
  Reference,
  RenderArtifact,
  UXImpact,
} from "@design-sharingan/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveFeatureEvolveApproach,
  commitFeatureEvolveResult,
  commitReferenceScan,
  ensureDesignWorkspace,
  listReferences,
  listSessions,
  loadReference,
  loadReferenceImage,
  loadReferenceDesignDNA,
  loadApprovedExecutionDirection,
  loadSession,
  loadProjectMetadata,
  saveReferenceDesignDNA,
  saveGuardedProjectMetadata,
  saveProjectMetadata,
  saveReferenceArtifact,
  saveRenderArtifact,
  saveSession,
  transitionLearnSession,
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

function referenceScanPendingSessionFixture(
  status: "DRAFT" | "ANALYZING" = "DRAFT",
  id = "session-1",
) {
  return {
    ...sessionFixture(id),
    type: "REFERENCE_SCAN" as const,
    status,
    referenceId: "reference-1",
    referenceTitle: "Reference",
  };
}

function referenceScanResultSessionFixture(
  id = "session-1",
  designDNA = designDNAFixture(),
) {
  return {
    ...sessionFixture(id),
    type: "REFERENCE_SCAN" as const,
    status: "RESULT_READY" as const,
    referenceId: "reference-1",
    referenceTitle: "Reference",
    designDNA,
    agentThreadId: "thread-1",
  };
}

const featureBriefFixture: FeatureBrief = {
  name: "Evidence inbox",
  goal: "Triage unresolved design evidence.",
  description: "Add an evidence inbox without changing navigation.",
  constraints: ["Use the existing project rail"],
  mustKeep: ["Reports remain durable history"],
  mustNotChange: ["Do not add navigation destinations"],
  successCriteria: ["Reviewers can resolve one item in under a minute"],
};

const uxImpactFixture: UXImpact = {
  area: "Reference review",
  severity: "IMPORTANT",
  reason: "The prioritization model becomes explicit.",
  affectedRoutes: ["/projects/:projectId/references"],
  affectedComponents: ["ReferenceCard"],
  decisionRequired: true,
};

function approachFixture(
  id = "approach-guided-queue",
  recommended = true,
): DesignApproach {
  return {
    id,
    title: recommended ? "Guided evidence queue" : "Inline review markers",
    summary: "Make unresolved evidence explicit without changing navigation.",
    recommended,
    pros: ["Preserves the information architecture"],
    cons: ["Adds a review state to each reference"],
    uxImpact: [uxImpactFixture],
    estimatedComplexity: "MEDIUM",
    genomeFit: "Fits the evidence-first product model.",
    likelyFiles: ["features/references/reference-card.tsx"],
    status: "PROPOSED",
  };
}

function featureEvolvePendingSessionFixture(
  status: "DRAFT" | "ANALYZING" = "DRAFT",
) {
  return {
    id: "feature-evolve-1",
    projectId: "project-1",
    type: "FEATURE_EVOLVE" as const,
    status,
    createdAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
    featureBrief: featureBriefFixture,
    referenceIds: ["reference-1"],
  };
}

function featureEvolveResultSessionFixture(
  status: "RESULT_READY" | "AWAITING_DECISION" = "RESULT_READY",
) {
  return {
    ...featureEvolvePendingSessionFixture("ANALYZING"),
    status,
    uxImpact: [uxImpactFixture],
    approaches: [
      approachFixture(),
      approachFixture("approach-inline-markers", false),
    ],
    agentThreadId: "thread-feature-evolve-1",
  };
}

function approvalFixture(): Approval {
  return {
    id: "approval-design-approach-1",
    proposalId: "approach-guided-queue",
    decision: "APPROVED",
    scope: "DESIGN_APPROACH",
    approvedBy: "local-user",
    comment: "Proceed with the evidence queue.",
    createdAt: "2026-08-24T11:00:00.000Z",
  };
}

function approvedFeatureEvolveSessionFixture() {
  const approval = approvalFixture();
  return {
    ...featureEvolveResultSessionFixture("AWAITING_DECISION"),
    status: "APPROVED" as const,
    updatedAt: approval.createdAt,
    approvedApproachId: "approach-guided-queue",
    approval,
    executeSessionId: "safe-execution-1",
  };
}

function safeExecutionDraftFixture() {
  return {
    id: "safe-execution-1",
    projectId: "project-1",
    type: "SAFE_EXECUTION" as const,
    status: "IDLE" as const,
    createdAt: "2026-08-24T11:00:00.000Z",
    updatedAt: "2026-08-24T11:00:00.000Z",
    sourceSessionId: "feature-evolve-1",
    approvedApproachId: "approach-guided-queue",
    approvalId: "approval-design-approach-1",
    featureBrief: featureBriefFixture,
    designApproach: approachFixture(),
  };
}

function approvalCheckpoint(
  awaiting: ReturnType<typeof featureEvolveResultSessionFixture>,
  approachId: string,
  suffix: string,
) {
  const designApproach = awaiting.approaches.find(
    (approach) => approach.id === approachId,
  );
  if (designApproach === undefined) throw new Error("Missing fixture approach");
  const approval: Approval = {
    ...approvalFixture(),
    id: `approval-${suffix}`,
    proposalId: approachId,
  };
  const executeSession = {
    ...safeExecutionDraftFixture(),
    id: `safe-execution-${suffix}`,
    createdAt: approval.createdAt,
    updatedAt: approval.createdAt,
    sourceSessionId: awaiting.id,
    approvedApproachId: approachId,
    approvalId: approval.id,
    designApproach,
  };
  return {
    approval,
    executeSession,
    session: {
      ...awaiting,
      status: "APPROVED" as const,
      updatedAt: approval.createdAt,
      approvedApproachId: approachId,
      approval,
      executeSessionId: executeSession.id,
    },
  };
}

// Production break caught: a generic session write could skip the explicit
// Feature EVOLVE lifecycle or persist approaches whose evidence does not match
// the pending Feature Brief and reference provenance.
it("commits Feature EVOLVE evidence only from its matching ANALYZING session", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const draft = featureEvolvePendingSessionFixture();
  const analyzing = featureEvolvePendingSessionFixture("ANALYZING");
  const result = featureEvolveResultSessionFixture();

  await saveSession(rootPath, draft);
  await expect(commitFeatureEvolveResult(rootPath, result)).rejects.toThrow(
    /ANALYZING|matching/i,
  );
  await expect(loadSession(rootPath, "project-1", draft.id)).resolves.toEqual(
    draft,
  );

  await transitionLearnSession(rootPath, "DRAFT", analyzing);
  await commitFeatureEvolveResult(rootPath, result);
  await expect(loadSession(rootPath, "project-1", draft.id)).resolves.toEqual(
    result,
  );

  const awaiting = featureEvolveResultSessionFixture("AWAITING_DECISION");
  await transitionLearnSession(rootPath, "RESULT_READY", awaiting);
  await expect(loadSession(rootPath, "project-1", draft.id)).resolves.toEqual(
    awaiting,
  );
});

// Production break caught: an approval for a different approach, incomplete
// result evidence, or mismatched execution provenance must not authorize the
// draft Task 9 will later consume.
it.each([
  [
    "a stale approach approval",
    () => ({
      approved: approvedFeatureEvolveSessionFixture(),
      approval: { ...approvalFixture(), proposalId: "approach-inline-markers" },
      execute: safeExecutionDraftFixture(),
    }),
  ],
  [
    "a non-approved decision",
    () => ({
      approved: {
        ...approvedFeatureEvolveSessionFixture(),
        approval: { ...approvalFixture(), decision: "REJECTED" as const },
      },
      approval: { ...approvalFixture(), decision: "REJECTED" as const },
      execute: safeExecutionDraftFixture(),
    }),
  ],
  [
    "a wrong approval scope",
    () => ({
      approved: {
        ...approvedFeatureEvolveSessionFixture(),
        approval: { ...approvalFixture(), scope: "CHANGE_PROPOSAL" },
      },
      approval: { ...approvalFixture(), scope: "CHANGE_PROPOSAL" },
      execute: safeExecutionDraftFixture(),
    }),
  ],
  [
    "a mismatched execution source",
    () => ({
      approved: approvedFeatureEvolveSessionFixture(),
      approval: approvalFixture(),
      execute: { ...safeExecutionDraftFixture(), sourceSessionId: "feature-evolve-2" },
    }),
  ],
  [
    "a different execution approach",
    () => ({
      approved: approvedFeatureEvolveSessionFixture(),
      approval: approvalFixture(),
      execute: {
        ...safeExecutionDraftFixture(),
        designApproach: approachFixture("approach-inline-markers", false),
      },
    }),
  ],
] as const)("rejects %s before persisting an approval", async (_label, invalid) => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const awaiting = featureEvolveResultSessionFixture("AWAITING_DECISION");
  await saveSession(rootPath, awaiting);
  const checkpoint = invalid();

  await expect(
    approveFeatureEvolveApproach(rootPath, {
      session: checkpoint.approved as ReturnType<
        typeof approvedFeatureEvolveSessionFixture
      >,
      approval: checkpoint.approval,
      executeSession: checkpoint.execute as ReturnType<
        typeof safeExecutionDraftFixture
      >,
    }),
  ).rejects.toThrow(/approval|approach|matching|scope/i);

  await expect(loadSession(rootPath, "project-1", awaiting.id)).resolves.toEqual(
    awaiting,
  );
  await expect(
    loadSession(rootPath, "project-1", "safe-execution-1"),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

type ApprovalCheckpointFixture = ReturnType<typeof approvalCheckpoint>;

const incoherentTimestampCases: readonly [
  string,
  (checkpoint: ApprovalCheckpointFixture) => ApprovalCheckpointFixture,
][] = [
  [
    "approved source updatedAt",
    (checkpoint) => ({
      ...checkpoint,
      session: {
        ...checkpoint.session,
        updatedAt: "2026-08-24T10:59:59.000Z",
      },
    }),
  ],
  [
    "execution createdAt",
    (checkpoint) => ({
      ...checkpoint,
      executeSession: {
        ...checkpoint.executeSession,
        createdAt: "2026-08-24T10:59:59.000Z",
      },
    }),
  ],
  [
    "execution updatedAt",
    (checkpoint) => ({
      ...checkpoint,
      executeSession: {
        ...checkpoint.executeSession,
        updatedAt: "2026-08-24T10:59:59.000Z",
      },
    }),
  ],
];

// Production break caught: the writer can otherwise persist a checkpoint
// that its relational Execute loader must reject. Timestamp validation must
// happen before the exclusive claim, including when a stale claim exists.
it.each(incoherentTimestampCases)(
  "rejects incoherent %s before acquiring the approval claim",
  async (_label, makeIncoherent) => {
    const rootPath = await temporaryProject();
    await saveProjectMetadata(projectFixture(rootPath));
    const awaiting = featureEvolveResultSessionFixture("AWAITING_DECISION");
    await saveSession(rootPath, awaiting);
    const checkpoint = makeIncoherent(
      approvalCheckpoint(awaiting, "approach-guided-queue", "timestamp"),
    );
    const claimPath = join(
      rootPath,
      ".design-sharingan",
      "sessions",
      `.${awaiting.id}.approval.claim`,
    );
    await writeFile(claimPath, "stale claim remains fail-closed\n");

    await expect(
      approveFeatureEvolveApproach(rootPath, checkpoint),
    ).rejects.toThrow(/timestamp|createdAt|updatedAt/i);

    await expect(
      loadSession(rootPath, "project-1", awaiting.id),
    ).resolves.toEqual(awaiting);
    await expect(
      loadSession(rootPath, "project-1", checkpoint.executeSession.id),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(claimPath, "utf8")).resolves.toBe(
      "stale claim remains fail-closed\n",
    );
  },
);

// Production break caught: exposing SAFE_EXECUTION before its design approval
// is durable, or leaving the approval visible after the linked-draft write
// fails, creates an unauthorized mutation path.
it("persists approval before the linked SAFE_EXECUTION draft and rolls both back on failure", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const awaiting = featureEvolveResultSessionFixture("AWAITING_DECISION");
  await saveSession(rootPath, awaiting);

  const sessionsPath = join(rootPath, ".design-sharingan", "sessions");
  await mkdir(join(sessionsPath, "safe-execution-1.json"));
  await expect(
    approveFeatureEvolveApproach(rootPath, {
      session: approvedFeatureEvolveSessionFixture(),
      approval: approvalFixture(),
      executeSession: safeExecutionDraftFixture(),
    }),
  ).rejects.toThrow();
  await expect(loadSession(rootPath, "project-1", awaiting.id)).resolves.toEqual(
    awaiting,
  );
  await expect(
    loadSession(rootPath, "project-1", "safe-execution-1"),
  ).rejects.toThrow();

  await rm(join(sessionsPath, "safe-execution-1.json"), { recursive: true });
  await approveFeatureEvolveApproach(rootPath, {
    session: approvedFeatureEvolveSessionFixture(),
    approval: approvalFixture(),
    executeSession: safeExecutionDraftFixture(),
  });
  await expect(loadSession(rootPath, "project-1", awaiting.id)).resolves.toEqual(
    approvedFeatureEvolveSessionFixture(),
  );
  await expect(
    loadSession(rootPath, "project-1", "safe-execution-1"),
  ).resolves.toEqual(safeExecutionDraftFixture());
});

// Production break caught: two requests that both read AWAITING_DECISION can
// otherwise approve different approaches, create two execution drafts, and let
// one rollback overwrite the other's successful approved source record.
it("serializes competing Feature EVOLVE approvals so exactly one direction wins", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const awaiting = featureEvolveResultSessionFixture("AWAITING_DECISION");
  await saveSession(rootPath, awaiting);
  const guided = approvalCheckpoint(
    awaiting,
    "approach-guided-queue",
    "guided",
  );
  const inline = approvalCheckpoint(
    awaiting,
    "approach-inline-markers",
    "inline",
  );

  const results = await Promise.allSettled([
    approveFeatureEvolveApproach(rootPath, guided),
    approveFeatureEvolveApproach(rootPath, inline),
  ]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  const winningIndex = results.findIndex(
    (result) => result.status === "fulfilled",
  );
  const winner = winningIndex === 0 ? guided : inline;
  const loser = winningIndex === 0 ? inline : guided;
  const sessions = await listSessions(rootPath, "project-1");
  const approved = sessions.find(
    (session) => session.type === "FEATURE_EVOLVE",
  ) as ReturnType<typeof approvedFeatureEvolveSessionFixture>;
  const executionDrafts = sessions.filter(
    (session) => session.type === "SAFE_EXECUTION",
  );
  expect(executionDrafts).toHaveLength(1);
  expect(approved.status).toBe("APPROVED");
  expect(executionDrafts[0]).toMatchObject({
    id: approved.executeSessionId,
    sourceSessionId: approved.id,
    approvedApproachId: approved.approvedApproachId,
    approvalId: approved.approval.id,
  });
  await expect(
    loadApprovedExecutionDirection(rootPath, "project-1"),
  ).resolves.toEqual(winner.executeSession);
  expect(approved.approvedApproachId).toBe(winner.session.approvedApproachId);
  expect(approved.approvedApproachId).not.toBe(loser.session.approvedApproachId);
  expect(
    sessions.some((session) => session.id === loser.executeSession.id),
  ).toBe(false);
});

// Production break caught: Execute must not surface a shape-valid draft whose
// linked approved source session is absent.
it("rejects an orphan SAFE_EXECUTION draft", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  await saveSession(rootPath, safeExecutionDraftFixture());

  await expect(
    loadApprovedExecutionDirection(rootPath, "project-1"),
  ).rejects.toThrow(/source|approved|evidence/i);
});

// Production break caught: a client-facing Execute projection must derive its
// authorization from the full relation, not independently valid JSON shapes.
it.each([
  [
    "altered approval",
    (source: ReturnType<typeof approvedFeatureEvolveSessionFixture>) => ({
      ...source,
      approval: { ...source.approval, id: "approval-tampered" },
    }),
  ],
  [
    "altered selected approach",
    (source: ReturnType<typeof approvedFeatureEvolveSessionFixture>) => ({
      ...source,
      approaches: source.approaches.map((approach) =>
        approach.id === source.approvedApproachId
          ? { ...approach, summary: "Tampered direction" }
          : approach,
      ),
    }),
  ],
  [
    "altered Feature Brief",
    (source: ReturnType<typeof approvedFeatureEvolveSessionFixture>) => ({
      ...source,
      featureBrief: { ...source.featureBrief, goal: "Tampered goal" },
    }),
  ],
  [
    "mismatched execute id",
    (source: ReturnType<typeof approvedFeatureEvolveSessionFixture>) => ({
      ...source,
      executeSessionId: "safe-execution-tampered",
    }),
  ],
] as const)("rejects relational Execute evidence with %s", async (_label, tamper) => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const awaiting = featureEvolveResultSessionFixture("AWAITING_DECISION");
  await saveSession(rootPath, awaiting);
  await approveFeatureEvolveApproach(rootPath, {
    session: approvedFeatureEvolveSessionFixture(),
    approval: approvalFixture(),
    executeSession: safeExecutionDraftFixture(),
  });
  await saveSession(
    rootPath,
    tamper(approvedFeatureEvolveSessionFixture()),
  );

  await expect(
    loadApprovedExecutionDirection(rootPath, "project-1"),
  ).rejects.toThrow(/approval|approach|brief|execute|evidence/i);
});

// Production break caught: without an explicit active-session selector, two
// drafts make the Execute route ambiguous and must fail closed.
it("rejects multiple SAFE_EXECUTION drafts instead of choosing one silently", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const awaiting = featureEvolveResultSessionFixture("AWAITING_DECISION");
  await saveSession(rootPath, awaiting);
  await approveFeatureEvolveApproach(rootPath, {
    session: approvedFeatureEvolveSessionFixture(),
    approval: approvalFixture(),
    executeSession: safeExecutionDraftFixture(),
  });
  await saveSession(rootPath, {
    ...safeExecutionDraftFixture(),
    id: "safe-execution-2",
  });

  await expect(
    loadApprovedExecutionDirection(rootPath, "project-1"),
  ).rejects.toThrow(/ambiguous|multiple/i);
});

it("loads an Execute direction only when every approval relation matches", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const awaiting = featureEvolveResultSessionFixture("AWAITING_DECISION");
  await saveSession(rootPath, awaiting);
  await approveFeatureEvolveApproach(rootPath, {
    session: approvedFeatureEvolveSessionFixture(),
    approval: approvalFixture(),
    executeSession: safeExecutionDraftFixture(),
  });

  await expect(
    loadApprovedExecutionDirection(rootPath, "project-1"),
  ).resolves.toEqual(safeExecutionDraftFixture());
});

// Production break caught: an engine or internal caller can otherwise commit
// a session larger than the loader's one-MiB ceiling, making the newly written
// checkpoint immediately unreadable.
it("rejects an oversized nested EVOLVE result and preserves ANALYZING", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const analyzing = featureEvolvePendingSessionFixture("ANALYZING");
  await saveSession(rootPath, analyzing);
  const oversized = featureEvolveResultSessionFixture();
  oversized.approaches[0] = {
    ...oversized.approaches[0],
    summary: "x".repeat(1024 * 1024),
  };

  await expect(
    commitFeatureEvolveResult(rootPath, oversized),
  ).rejects.toThrow(/too large|1 MiB/i);
  await expect(
    loadSession(rootPath, "project-1", analyzing.id),
  ).resolves.toEqual(analyzing);
});

// Production break caught: approval persistence writes the source record
// directly, so it needs the same pre-write byte guard as generic sessions.
it("rejects an oversized approval checkpoint and preserves AWAITING_DECISION", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const awaiting = featureEvolveResultSessionFixture("AWAITING_DECISION");
  await saveSession(rootPath, awaiting);
  const oversizedApproval = {
    ...approvalFixture(),
    comment: "x".repeat(1024 * 1024),
  };
  const oversizedSession = {
    ...approvedFeatureEvolveSessionFixture(),
    approval: oversizedApproval,
  };

  await expect(
    approveFeatureEvolveApproach(rootPath, {
      session: oversizedSession,
      approval: oversizedApproval,
      executeSession: safeExecutionDraftFixture(),
    }),
  ).rejects.toThrow(/too large|1 MiB/i);
  await expect(
    loadSession(rootPath, "project-1", awaiting.id),
  ).resolves.toEqual(awaiting);
  await expect(
    loadSession(rootPath, "project-1", "safe-execution-1"),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

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
  for (const inheritedName of ["constructor", "toString", "__proto__"]) {
    expect(() =>
      validateReferenceImage(
        inheritedName,
        new TextEncoder().encode("not an image"),
      ),
    ).toThrow(/PNG, JPEG, WebP, or GIF/i);
  }
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

// Production break caught: writing a completed scan directly can skip DRAFT -> ANALYZING, while separate final writes can leave DNA or ANALYZED metadata without a matching report.
it("enforces the Learn lifecycle and commits a completed reference scan as one rollback-safe checkpoint", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  await saveReferenceArtifact(rootPath, referenceFixture(), validPng);
  const persistedReference = await loadReference(
    rootPath,
    "project-1",
    "reference-1",
  );
  const draft = referenceScanPendingSessionFixture();
  const analyzing = { ...draft, status: "ANALYZING" as const };
  const completed = referenceScanResultSessionFixture();
  const analyzedReference = {
    ...persistedReference,
    analysisStatus: "ANALYZED" as const,
  };

  await saveSession(rootPath, draft);
  await expect(
    commitReferenceScan(rootPath, {
      reference: analyzedReference,
      designDNA: designDNAFixture(),
      session: completed,
    }),
  ).rejects.toThrow(/ANALYZING/i);
  await expect(
    loadReferenceDesignDNA(rootPath, "project-1", "reference-1"),
  ).rejects.toMatchObject({ code: "ENOENT" });

  await transitionLearnSession(rootPath, "DRAFT", analyzing);
  await expect(loadSession(rootPath, "project-1", draft.id)).resolves.toEqual(
    analyzing,
  );
  await commitReferenceScan(rootPath, {
    reference: analyzedReference,
    designDNA: designDNAFixture(),
    session: completed,
  });

  await expect(loadSession(rootPath, "project-1", draft.id)).resolves.toEqual(
    completed,
  );
  await expect(
    loadReferenceDesignDNA(rootPath, "project-1", "reference-1"),
  ).resolves.toEqual(designDNAFixture());
  await expect(
    loadReference(rootPath, "project-1", "reference-1"),
  ).resolves.toEqual(analyzedReference);
});

// Production break caught: a generic RESULT_READY session can otherwise
// advertise a report whose required evidence is absent or belongs to another
// reference/DesignDNA result.
it.each([
  [
    "missing report evidence",
    () => ({ ...sessionFixture(), status: "RESULT_READY" as const }),
  ],
  [
    "a different reference",
    () => ({
      ...referenceScanResultSessionFixture(),
      referenceId: "reference-2",
    }),
  ],
  [
    "a different DesignDNA identity",
    () => ({
      ...referenceScanResultSessionFixture(),
      designDNA: { ...designDNAFixture(), id: "dna-2" },
    }),
  ],
  [
    "different DesignDNA content",
    () => ({
      ...referenceScanResultSessionFixture(),
      designDNA: {
        ...designDNAFixture(),
        hierarchy: ["Unrelated hierarchy"],
      },
    }),
  ],
  [
    "an empty agent thread",
    () => ({
      ...referenceScanResultSessionFixture(),
      agentThreadId: "",
    }),
  ],
] as const)("rejects %s before mutating final scan evidence", async (_label, invalidSession) => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  await saveReferenceArtifact(rootPath, referenceFixture(), validPng);
  const originalReference = await loadReference(
    rootPath,
    "project-1",
    "reference-1",
  );
  const draft = referenceScanPendingSessionFixture();
  const analyzing = { ...draft, status: "ANALYZING" as const };
  await saveSession(rootPath, draft);
  await transitionLearnSession(rootPath, "DRAFT", analyzing);

  await expect(
    commitReferenceScan(rootPath, {
      reference: { ...originalReference, analysisStatus: "ANALYZED" },
      designDNA: designDNAFixture(),
      session: invalidSession() as Parameters<
        typeof commitReferenceScan
      >[1]["session"],
    }),
  ).rejects.toThrow(/matching|evidence/i);

  await expect(
    loadReference(rootPath, "project-1", "reference-1"),
  ).resolves.toEqual(originalReference);
  await expect(
    loadReferenceDesignDNA(rootPath, "project-1", "reference-1"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(loadSession(rootPath, "project-1", draft.id)).resolves.toEqual(
    analyzing,
  );
});

// Production break caught: checking only a persisted session's generic
// type/status/time lets an incomplete or unrelated ANALYZING record authorize
// a completed report, while `includes` admits multi-reference provenance for a
// single-reference SCAN.
it.each([
  [
    "missing pending reference identity",
    () => ({ ...sessionFixture(), status: "ANALYZING" as const }),
    () => designDNAFixture(),
  ],
  [
    "a different pending reference id",
    () => ({
      ...referenceScanPendingSessionFixture("ANALYZING"),
      referenceId: "reference-2",
    }),
    () => designDNAFixture(),
  ],
  [
    "a different pending reference title",
    () => ({
      ...referenceScanPendingSessionFixture("ANALYZING"),
      referenceTitle: "Another reference",
    }),
    () => designDNAFixture(),
  ],
  [
    "extra DesignDNA reference provenance",
    () => referenceScanPendingSessionFixture("ANALYZING"),
    () => ({
      ...designDNAFixture(),
      referenceIds: ["reference-1", "reference-2"],
    }),
  ],
] as const)(
  "rejects %s without changing pending evidence",
  async (_label, pendingSession, checkpointDesignDNA) => {
    const rootPath = await temporaryProject();
    await saveProjectMetadata(projectFixture(rootPath));
    await saveReferenceArtifact(rootPath, referenceFixture(), validPng);
    const originalReference = await loadReference(
      rootPath,
      "project-1",
      "reference-1",
    );
    const originalDesignDNA = {
      ...designDNAFixture(),
      id: "dna-before-invalid-checkpoint",
      hierarchy: ["Existing evidence"],
    };
    await saveReferenceDesignDNA(
      rootPath,
      "project-1",
      "reference-1",
      originalDesignDNA,
    );
    const persistedPending = pendingSession();
    await saveSession(rootPath, persistedPending);
    const finalDesignDNA = checkpointDesignDNA();

    await expect(
      commitReferenceScan(rootPath, {
        reference: { ...originalReference, analysisStatus: "ANALYZED" },
        designDNA: finalDesignDNA,
        session: referenceScanResultSessionFixture(
          persistedPending.id,
          finalDesignDNA,
        ),
      }),
    ).rejects.toThrow(/matching|evidence/i);

    await expect(
      loadReference(rootPath, "project-1", "reference-1"),
    ).resolves.toEqual(originalReference);
    await expect(
      loadReferenceDesignDNA(rootPath, "project-1", "reference-1"),
    ).resolves.toEqual(originalDesignDNA);
    await expect(
      loadSession(rootPath, "project-1", persistedPending.id),
    ).resolves.toEqual(persistedPending);
  },
);

// Production break caught: callers must not reset the durable start time while
// advancing the same Learn session through its lifecycle.
it("preserves immutable Learn session identity across transitions", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const draft = referenceScanPendingSessionFixture();
  await saveSession(rootPath, draft);

  await expect(
    transitionLearnSession(rootPath, "DRAFT", {
      ...draft,
      status: "ANALYZING",
      createdAt: "2026-08-25T09:00:00.000Z",
    }),
  ).rejects.toThrow(/identity|createdAt/i);
  await expect(loadSession(rootPath, "project-1", draft.id)).resolves.toEqual(
    draft,
  );
});

// Production break caught: a late session-write failure previously left the earlier DNA/reference writes visible without a completed Design Session.
it("rolls back DNA and reference metadata when the final scan checkpoint cannot persist", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  await saveReferenceArtifact(rootPath, referenceFixture(), validPng);
  const originalReference = await loadReference(
    rootPath,
    "project-1",
    "reference-1",
  );
  const draft = referenceScanPendingSessionFixture();
  const analyzing = { ...draft, status: "ANALYZING" as const };
  await saveSession(rootPath, draft);
  await transitionLearnSession(rootPath, "DRAFT", analyzing);
  const originalDesignDNA = {
    ...designDNAFixture(),
    id: "dna-before-failed-checkpoint",
    hierarchy: ["Previously persisted hierarchy"],
  };
  await saveReferenceDesignDNA(
    rootPath,
    "project-1",
    "reference-1",
    originalDesignDNA,
  );

  const sessionsPath = join(rootPath, ".design-sharingan", "sessions");
  await chmod(sessionsPath, 0o500);
  try {
    await expect(
      commitReferenceScan(rootPath, {
        reference: {
          ...originalReference,
          analysisStatus: "ANALYZED",
        },
        designDNA: designDNAFixture(),
        session: referenceScanResultSessionFixture(),
      }),
    ).rejects.toThrow();
  } finally {
    await chmod(sessionsPath, 0o700);
  }

  await expect(
    loadReference(rootPath, "project-1", "reference-1"),
  ).resolves.toEqual(originalReference);
  await expect(
    loadReferenceDesignDNA(rootPath, "project-1", "reference-1"),
  ).resolves.toEqual(originalDesignDNA);
  await expect(loadSession(rootPath, "project-1", draft.id)).resolves.toEqual(
    analyzing,
  );
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
