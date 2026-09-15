import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
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
  listActivityEvents,
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
  assertRenderArtifactIntegrity,
  saveSession,
  setLearnTransitionHookForTest,
  setSessionCommitFaultForTest,
  transitionLearnSession,
  updateReference,
  validateReferenceImage,
} from "../workspace-store";

const temporaryRoots: string[] = [];
const PNG_LIMIT_BYTES = 25 * 1024 * 1024;

function pngBytes(width = 1440, height = 800, totalBytes = 24): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "design-sharingan-store-"));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(async () => {
  setLearnTransitionHookForTest(undefined);
  setSessionCommitFaultForTest(undefined);
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

// Production break caught: racing the first workspace initialization throws EEXIST or overwrites another caller's newly saved project metadata.
it("initializes the fixed workspace concurrently without replacing project identity", async () => {
  const root = await realpath(await temporaryProject());
  const initializers = await Promise.allSettled(Array.from({ length: 12 }, () => ensureDesignWorkspace(root)));
  expect(initializers.every((result) => result.status === "fulfilled")).toBe(true);
  const project = projectFixture(root);
  await Promise.all([saveProjectMetadata(project), ...Array.from({ length: 8 }, () => ensureDesignWorkspace(root))]);
  await expect(loadProjectMetadata(root, project.id)).resolves.toEqual(project);
});

// Production break caught: malformed metadata must remain an error, never be reset to an empty workspace during initialization recovery.
it("preserves malformed project JSON and refuses to infer its identity", async () => {
  const root = await realpath(await temporaryProject()); await saveProjectMetadata(projectFixture(root));
  const path = join(root, ".design-sharingan/project.json"); await writeFile(path, "{ malformed");
  await expect(loadProjectMetadata(root, "project-1")).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("{ malformed");
});

// Production break caught: a generic Learn transition can silently switch the reference/source identity while preserving a session id.
it("rejects reference identity substitution at the intrinsic Learn transition boundary", async () => {
  const root = await temporaryProject(); await saveProjectMetadata(projectFixture(root));
  const draft = referenceScanPendingSessionFixture(); await saveSession(root, draft);
  const substituted = { ...draft, status: "ANALYZING" as const, referenceId: "different-reference", updatedAt: "2026-08-24T10:01:00.000Z" };
  await expect(transitionLearnSession(root, "DRAFT", substituted)).rejects.toThrow(/identity/);
  await expect(loadSession(root, "project-1", draft.id)).resolves.toEqual(draft);
});

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

// Production break caught: an interrupted approval leaves an exclusive file forever, even when its owner died and the authenticated source session is unchanged.
it("recovers an owner-bound expired approval claim against its authenticated source checkpoint", async () => {
  const root = await temporaryProject();
  await saveProjectMetadata(projectFixture(root));
  const awaiting = featureEvolveResultSessionFixture("AWAITING_DECISION");
  await saveSession(root, awaiting);
  const head = JSON.parse(await readFile(join(root, ".design-sharingan/activity", `${awaiting.id}.session-head.json`), "utf8"));
  await writeFile(join(root, ".design-sharingan/sessions", `.${awaiting.id}.approval.claim`), JSON.stringify({
    kind: "DESIGN_SHARINGAN_LEARN_CLAIM", ownerId: "11111111-1111-4111-8111-111111111111", pid: 2_147_483_646,
    projectId: "project-1", sessionId: awaiting.id, expectedStatus: "AWAITING_DECISION", expectedSessionHash: head.sessionHash,
    leaseExpiresAt: "2026-08-24T09:00:01.000Z",
  }));
  await approveFeatureEvolveApproach(root, approvalCheckpoint(awaiting, "approach-guided-queue", "recovered"));
  expect((await loadSession(root, "project-1", awaiting.id)).status).toBe("APPROVED");
  expect((await loadApprovedExecutionDirection(root, "project-1")).id).toBe("safe-execution-recovered");
});

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

// The two body records and both immutable journals are already durable at
// this boundary. A failed final head write must recover to one coherent new
// pair, never a Safe body without its authenticating approval journal/head.
it("rolls a partial Feature EVOLVE approval head publish forward coherently", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const awaiting = featureEvolveResultSessionFixture("AWAITING_DECISION");
  await saveSession(rootPath, awaiting);
  setSessionCommitFaultForTest("after-execution-head-before-approval-head");
  await expect(approveFeatureEvolveApproach(rootPath, {
    session: approvedFeatureEvolveSessionFixture(),
    approval: approvalFixture(),
    executeSession: safeExecutionDraftFixture(),
  })).rejects.toThrow(/injected session commit crash/i);
  setSessionCommitFaultForTest(undefined);

  await expect(loadSession(rootPath, "project-1", awaiting.id)).resolves.toEqual(
    approvedFeatureEvolveSessionFixture(),
  );
  await expect(loadSession(rootPath, "project-1", "safe-execution-1")).resolves.toEqual(
    safeExecutionDraftFixture(),
  );
  await expect(listActivityEvents(rootPath, "project-1")).resolves.toHaveLength(3);
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

it("rolls a partial reference SCAN head publish forward with matching artifacts", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  await saveReferenceArtifact(rootPath, referenceFixture(), validPng);
  const draft = referenceScanPendingSessionFixture();
  const analyzing = { ...draft, status: "ANALYZING" as const };
  const completed = referenceScanResultSessionFixture();
  await saveSession(rootPath, draft);
  await transitionLearnSession(rootPath, "DRAFT", analyzing);
  const original = await loadReference(rootPath, "project-1", "reference-1");
  const analyzed = { ...original, analysisStatus: "ANALYZED" as const };
  setSessionCommitFaultForTest("after-reference-session-before-head");
  await expect(commitReferenceScan(rootPath, {
    reference: analyzed,
    designDNA: designDNAFixture(),
    session: completed,
  })).rejects.toThrow(/injected session commit crash/i);
  setSessionCommitFaultForTest(undefined);

  await expect(loadSession(rootPath, "project-1", draft.id)).resolves.toEqual(completed);
  await expect(loadReference(rootPath, "project-1", "reference-1")).resolves.toEqual(analyzed);
  await expect(loadReferenceDesignDNA(rootPath, "project-1", "reference-1"))
    .resolves.toEqual(designDNAFixture());
  await expect(listActivityEvents(rootPath, "project-1")).resolves.toHaveLength(3);
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

// Fix-round probe: an activity record is only valid for the immutable session
// checkpoint that produced it; replacing the session must not leave a stale
// event looking current.
it("rejects activity whose session checkpoint was replaced", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const session = sessionFixture("stale-activity");
  await saveSession(rootPath, session);
  await writeFile(
    join(rootPath, ".design-sharingan", "sessions", `${session.id}.json`),
    `${JSON.stringify({ ...session, status: "ANALYZING", updatedAt: "2026-08-24T10:00:01.000Z" })}\n`,
  );

  await expect(listActivityEvents(rootPath, "project-1"))
    .rejects.toThrow(/checkpoint|stale|identity|activity/i);
});

// Fix-round probe: a checkpoint without its event is not a recoverable
// activity transition and must never be silently dropped from the report.
it("rejects an orphaned activity checkpoint", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const session = sessionFixture("orphaned-checkpoint");
  await saveSession(rootPath, session);
  const activityPath = join(rootPath, ".design-sharingan", "activity");
  const eventName = (await readdir(activityPath)).find((name) => !name.endsWith(".checkpoint.json"));
  expect(eventName).toBeDefined();
  await unlink(join(activityPath, eventName!));

  await expect(listActivityEvents(rootPath, "project-1"))
    .rejects.toThrow(/orphan|checkpoint|activity/i);
});

// Fix-round probe: durable failure state must produce a concrete failure
// activity record instead of looking like an in-progress analysis.
it("records a failure activity message for a failed scan", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const failed = {
    ...referenceScanPendingSessionFixture("ANALYZING", "failed-scan"),
    error: "Reference image analysis failed after the worker exited.",
  };
  await saveSession(rootPath, failed);

  const [event] = await listActivityEvents(rootPath, "project-1");
  expect(event?.message).toMatch(/failed/i);
});

// Fix-round probe: runtime records must not be readable through a hard link
// that gives an unrelated directory another name for the same inode.
it("rejects a hard-linked session record", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const session = sessionFixture("hard-linked-session");
  await saveSession(rootPath, session);
  const sessionPath = join(
    rootPath,
    ".design-sharingan",
    "sessions",
    `${session.id}.json`,
  );
  await link(sessionPath, join(rootPath, "hard-linked-session.json"));

  await expect(loadSession(rootPath, "project-1", session.id))
    .rejects.toThrow(/regular|hard|invalid/i);
});

// Fix-round probe: directory growth is bounded before any untrusted JSON is
// read, preventing a large or malicious history from becoming an unbounded
// Promise.all fan-out.
it("rejects a session history beyond the bounded entry budget", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const sessionsPath = join(rootPath, ".design-sharingan", "sessions");
  await Promise.all(Array.from({ length: 513 }, (_, index) => writeFile(
    join(sessionsPath, `history-${index}.json`),
    `${JSON.stringify({
      id: `history-${index}`,
      projectId: "project-1",
      type: "REFERENCE_SCAN",
      status: "DRAFT",
      createdAt: "2026-08-24T09:00:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
    })}\n`,
  )));

  await expect(listSessions(rootPath, "project-1"))
    .rejects.toThrow(/bounded|history|entries|budget/i);
});

// Fix-round probe: pagination bounds must include directory entries that are
// not JSON records; otherwise junk can evade the pre-read budget.
it("rejects a session directory beyond the total entry budget", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const sessionsPath = join(rootPath, ".design-sharingan", "sessions");
  await Promise.all(Array.from({ length: 513 }, (_, index) => writeFile(
    join(sessionsPath, `junk-${index}.txt`),
    "junk",
  )));

  await expect(listSessions(rootPath, "project-1"))
    .rejects.toThrow(/bounded|history|entries|budget/i);
});

// Fix-round probe: two callers claiming the same learn transition must have
// one winner and one observable rejection, with no event for the loser.
it("uses a compare-and-swap claim for concurrent learn transitions", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const starting = sessionFixture("cas-session");
  await saveSession(rootPath, starting);
  const first = { ...starting, status: "ANALYZING" as const, updatedAt: "2026-08-24T10:00:01.000Z" };
  const second = { ...starting, status: "ANALYZING" as const, updatedAt: "2026-08-24T10:00:02.000Z" };

  const results = await Promise.allSettled([
    transitionLearnSession(rootPath, "DRAFT", first),
    transitionLearnSession(rootPath, "DRAFT", second),
  ]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  const activity = await listActivityEvents(rootPath, "project-1");
  expect(activity.filter((event) => event.sessionId === starting.id)).toHaveLength(2);
  expect(activity.filter((event) => event.message === "Analyzing reference")).toHaveLength(1);
});

// A process can die immediately after claiming, before it mutates the session.
// PID liveness alone is not ownership (PIDs can be reused, including by this
// test process), so an expired authenticated claim must not wedge Learn.
it.each([
  ["dead owner", 2_147_483_646],
  ["PID reuse", process.pid],
  ["same-process stale owner", process.pid],
] as const)("recovers an expired %s Learn claim before mutation", async (_label, pid) => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const starting = sessionFixture(`expired-learn-${pid}`);
  await saveSession(rootPath, starting);
  const head = JSON.parse(await readFile(
    join(rootPath, ".design-sharingan", "activity", `${starting.id}.session-head.json`),
    "utf8",
  )) as { sessionHash: string };
  await writeFile(
    join(rootPath, ".design-sharingan", "sessions", `.${starting.id}.learn.claim`),
    `${JSON.stringify({
      kind: "DESIGN_SHARINGAN_LEARN_CLAIM",
      ownerId: "11111111-1111-4111-8111-111111111111",
      pid,
      projectId: "project-1",
      sessionId: starting.id,
      expectedStatus: "DRAFT",
      expectedSessionHash: head.sessionHash,
      leaseExpiresAt: "2026-08-24T09:00:01.000Z",
    })}\n`,
  );

  await expect(transitionLearnSession(rootPath, "DRAFT", {
    ...starting,
    status: "ANALYZING",
    updatedAt: "2026-08-24T10:00:01.000Z",
  })).resolves.toBeDefined();
});

// Fix-round-2 probe: a losing caller must never unlink the winner's claim.
// The third caller begins after the first has committed but before its cleanup,
// forcing stale recovery and then letting the first cleanup interleave with the
// third owner's live claim.
it("preserves the exact Learn claim owner across a deterministic three-caller interleave", async () => {
  const rootPath = await temporaryProject();
  await saveProjectMetadata(projectFixture(rootPath));
  const starting = sessionFixture("three-caller-cas");
  await saveSession(rootPath, starting);
  const analyzing = {
    ...starting,
    status: "ANALYZING" as const,
    updatedAt: "2026-08-24T10:00:01.000Z",
  };
  const ready = {
    ...starting,
    status: "RESULT_READY" as const,
    updatedAt: "2026-08-24T10:00:02.000Z",
  };

  let firstOwner: string | undefined;
  let releaseFirstAction!: () => void;
  let releaseFirstCleanup!: () => void;
  let releaseThirdAction!: () => void;
  const firstMayAct = new Promise<void>((resolve) => { releaseFirstAction = resolve; });
  const firstMayClean = new Promise<void>((resolve) => { releaseFirstCleanup = resolve; });
  const thirdMayAct = new Promise<void>((resolve) => { releaseThirdAction = resolve; });
  let firstClaimed!: () => void;
  let firstCommitted!: () => void;
  let thirdClaimed!: () => void;
  const firstClaim = new Promise<void>((resolve) => { firstClaimed = resolve; });
  const firstCommit = new Promise<void>((resolve) => { firstCommitted = resolve; });
  const thirdClaim = new Promise<void>((resolve) => { thirdClaimed = resolve; });

  setLearnTransitionHookForTest(async ({ point, ownerId }) => {
    if (point === "after-claim" && firstOwner === undefined) {
      firstOwner = ownerId;
      firstClaimed();
      await firstMayAct;
      return;
    }
    if (point === "before-release" && ownerId === firstOwner) {
      firstCommitted();
      await firstMayClean;
      return;
    }
    if (point === "after-claim") {
      thirdClaimed();
      await thirdMayAct;
    }
  });

  const first = transitionLearnSession(rootPath, "DRAFT", analyzing);
  await firstClaim;
  await expect(
    transitionLearnSession(rootPath, "DRAFT", {
      ...analyzing,
      updatedAt: "2026-08-24T10:00:01.500Z",
    }),
  ).rejects.toThrow(/already in progress|claim/i);
  releaseFirstAction();
  await firstCommit;

  const third = transitionLearnSession(rootPath, "ANALYZING", ready);
  await thirdClaim;
  releaseFirstCleanup();
  await first;
  releaseThirdAction();
  await third;

  await expect(loadSession(rootPath, "project-1", starting.id)).resolves.toEqual(ready);
  const activity = await listActivityEvents(rootPath, "project-1");
  expect(activity.filter(({ sessionId }) => sessionId === starting.id)).toHaveLength(3);
  await expect(
    lstat(join(rootPath, ".design-sharingan", "sessions", `.${starting.id}.learn.claim`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  ["after-journal-before-session", "DRAFT", 1],
  ["after-session-before-commit", "ANALYZING", 2],
] as const)(
  "recovers Learn session/activity truth after a forced crash %s",
  async (fault, expectedStatus, expectedEvents) => {
    const rootPath = await temporaryProject();
    await saveProjectMetadata(projectFixture(rootPath));
    const starting = sessionFixture(`learn-crash-${expectedStatus.toLowerCase()}`);
    await saveSession(rootPath, starting);
    setSessionCommitFaultForTest(fault);

    await expect(transitionLearnSession(rootPath, "DRAFT", {
      ...starting,
      status: "ANALYZING",
      updatedAt: "2026-08-24T10:00:01.000Z",
    })).rejects.toThrow(/injected session commit crash/i);
    setSessionCommitFaultForTest(undefined);

    await expect(loadSession(rootPath, "project-1", starting.id)).resolves.toMatchObject({
      status: expectedStatus,
    });
    const activity = await listActivityEvents(rootPath, "project-1");
    expect(activity.filter(({ sessionId }) => sessionId === starting.id)).toHaveLength(expectedEvents);
  },
);

// Production break caught: trusting render imagePath allows the evidence store to overwrite project source or outside files.
it("persists render bytes only inside the runtime renders directory", async () => {
  const rootPath = await temporaryProject();
  await ensureDesignWorkspace(rootPath);
  const validMetadata: RenderArtifact = {
    id: "render-1",
    sessionId: "session-1",
    roundId: "round-1",
    route: "/",
    viewport: "desktop",
    viewportWidth: 1440,
    viewportHeight: 800,
    imagePath: join(
      rootPath,
      ".design-sharingan",
      "renders",
      "session-1",
      "round-1",
      "desktop.png",
    ),
    capturedAt: "2026-08-24T10:00:00.000Z",
    sourceRevision: {
      kind: "UNVERSIONED",
      available: false,
      reason: "NOT_A_GIT_WORKSPACE",
    },
  };

  const saved = await saveRenderArtifact(
    rootPath,
    validMetadata,
    pngBytes(),
  );
  expect(new Uint8Array(await readFile(saved.artifactPath))).toEqual(
    pngBytes(),
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
      pngBytes(),
    ),
  ).rejects.toThrow(/outside active project/i);

  await expect(
    saveRenderArtifact(
      rootPath,
      {
        ...validMetadata,
        imagePath: join(
          rootPath,
          ".design-sharingan",
          "renders",
          "session-1",
          "different-round",
          "desktop.png",
        ),
      },
      pngBytes(),
    ),
  ).rejects.toThrow(/exact render artifact path/i);
});

// Production break caught: callers outside render-engine could persist malformed or non-PNG evidence under a trusted RenderArtifact shape.
it("validates complete render evidence at the persistence boundary", async () => {
  const rootPath = await temporaryProject();
  await ensureDesignWorkspace(rootPath);
  const imagePath = join(rootPath, ".design-sharingan", "renders", "session-1", "round-1", "desktop.png");
  const metadata: RenderArtifact = {
    id: "render-1",
    sessionId: "session-1",
    roundId: "round-1",
    route: "/account",
    viewport: "desktop",
    viewportWidth: 1440,
    viewportHeight: 800,
    imagePath,
    capturedAt: "2026-08-25T09:00:00.000Z",
    sourceRevision: {
      kind: "GIT",
      available: true,
      head: "a".repeat(40),
      branch: "main",
      status: "CLEAN",
      entries: [],
      truncated: false,
      worktreeFingerprint: "b".repeat(64),
      fileCount: 1,
      requiredPathEvidence: [],
    },
  };
  const png = pngBytes();

  await expect(saveRenderArtifact(rootPath, { ...metadata, capturedAt: "yesterday" }, png)).rejects.toThrow(/timestamp/i);
  await expect(saveRenderArtifact(rootPath, { ...metadata, route: "https://example.com" }, png)).rejects.toThrow(/route/i);
  for (const route of ["/a/../account", "/account\r\nforged", "/account?next=%0d%0a"]) {
    await expect(saveRenderArtifact(rootPath, { ...metadata, route }, png)).rejects.toThrow(/route/i);
  }
  await expect(saveRenderArtifact(rootPath, { ...metadata, viewportWidth: 1280 }, png)).rejects.toThrow(/dimensions/i);
  await expect(saveRenderArtifact(rootPath, metadata, pngBytes(1440, 800, PNG_LIMIT_BYTES + 1))).rejects.toThrow(/too large/i);
  await expect(saveRenderArtifact(rootPath, {
    ...metadata,
    sourceRevision: {
      kind: "GIT",
      available: true,
      head: "a".repeat(40),
      branch: "main",
      status: "CLEAN",
      entries: [{ index: "?", workingTree: "?", path: "secret.txt" }],
      truncated: false,
      worktreeFingerprint: "b".repeat(64),
      fileCount: 1,
      requiredPathEvidence: [],
    },
  }, png)).rejects.toThrow(/source revision/i);
  await expect(saveRenderArtifact(rootPath, metadata, new Uint8Array([1, 2, 3]))).rejects.toThrow(/PNG/i);

  await expect(saveRenderArtifact(rootPath, {
    ...metadata,
    sourceRevision: {
      kind: "GIT",
      available: true,
      head: "a".repeat(40),
      branch: "main",
      status: "DIRTY",
      entries: [{ index: "X", workingTree: "M", path: "tracked.txt" }],
      truncated: false,
      worktreeFingerprint: "b".repeat(64),
      fileCount: 1,
      requiredPathEvidence: [],
    },
  }, png)).rejects.toThrow(/source revision/i);

  await expect(saveRenderArtifact(rootPath, {
    ...metadata,
    sourceRevision: {
      kind: "GIT",
      available: true,
      head: "a".repeat(40),
      branch: "界".repeat(100),
      status: "DIRTY",
      entries: [{ index: "?", workingTree: "?", path: "untracked.txt" }],
      truncated: false,
      worktreeFingerprint: "b".repeat(64),
      fileCount: 1,
      requiredPathEvidence: [],
    },
  }, png)).rejects.toThrow(/source revision/i);

  await expect(saveRenderArtifact(rootPath, {
    ...metadata,
    sourceRevision: { ...metadata.sourceRevision, worktreeFingerprint: "not-a-fingerprint" },
  } as RenderArtifact, png)).rejects.toThrow(/source revision/i);

  for (const path of [
    "a/../../outside.txt",
    "nested/../.git/config",
    "nested/../.design-sharingan/runtime.json",
    "nested\\windows-path.txt",
  ]) {
    await expect(saveRenderArtifact(rootPath, {
      ...metadata,
      sourceRevision: {
        kind: "GIT",
        available: true,
        head: "a".repeat(40),
        branch: "main",
        status: "DIRTY",
        entries: [{ index: "?", workingTree: "?", path }],
        truncated: false,
        worktreeFingerprint: "b".repeat(64),
        fileCount: 1,
        requiredPathEvidence: [],
      },
    }, png)).rejects.toThrow(/source revision/i);
  }

  await expect(saveRenderArtifact(rootPath, {
    ...metadata,
    sourceRevision: { ...metadata.sourceRevision, fileCount: 513 },
  } as RenderArtifact, png)).rejects.toThrow(/source revision/i);

  await expect(saveRenderArtifact(rootPath, {
    ...metadata,
    sourceRevision: {
      kind: "GIT",
      available: true,
      head: "a".repeat(40),
      branch: "main",
      status: "DIRTY",
      entries: [{ index: "?", workingTree: "?", path: "partial.txt" }],
      truncated: true,
      worktreeFingerprint: "b".repeat(64),
      fileCount: 2,
      requiredPathEvidence: [],
    },
  }, png)).rejects.toThrow(/source revision/i);

  await expect(saveRenderArtifact(rootPath, {
    ...metadata,
    sourceRevision: { ...metadata.sourceRevision, unexpected: true } as unknown as RenderArtifact["sourceRevision"],
  } as RenderArtifact, png)).rejects.toThrow(/source revision/i);

  await expect(saveRenderArtifact(rootPath, {
    ...metadata,
    sourceRevision: {
      ...metadata.sourceRevision,
      status: "DIRTY",
      entries: [{ index: "?", workingTree: "?", path: ".design-sharingan/runtime.json" }],
    },
  } as RenderArtifact, png)).rejects.toThrow(/source revision/i);

  await expect(saveRenderArtifact(rootPath, {
    ...metadata,
    unexpected: true,
  } as RenderArtifact, png)).rejects.toThrow(/metadata/i);

  await expect(saveRenderArtifact(rootPath, {
    ...metadata,
    sourceRevision: {
      kind: "UNVERSIONED",
      available: false,
      reason: "NOT_A_GIT_WORKSPACE",
      unexpected: true,
    },
  } as RenderArtifact, png)).rejects.toThrow(/source revision/i);
});

// Fix-round probe: every persisted render must retain the metadata and digest
// sidecars that authenticate its bytes and source revision.
it("rejects a render when either integrity sidecar is missing", async () => {
  const rootPath = await temporaryProject();
  await ensureDesignWorkspace(rootPath);
  const imagePath = join(rootPath, ".design-sharingan", "renders", "session-1", "round-1", "desktop.png");
  const metadata: RenderArtifact = {
    id: "render-sidecar",
    sessionId: "session-1",
    roundId: "round-1",
    route: "/",
    viewport: "desktop",
    viewportWidth: 1440,
    viewportHeight: 800,
    imagePath,
    capturedAt: "2026-08-25T09:00:00.000Z",
    sourceRevision: { kind: "UNVERSIONED", available: false, reason: "NOT_A_GIT_WORKSPACE" },
  };
  await saveRenderArtifact(rootPath, metadata, pngBytes());
  await unlink(join(rootPath, ".design-sharingan", "renders", "session-1", "round-1", "desktop.integrity.json"));

  await expect(assertRenderArtifactIntegrity(rootPath, metadata))
    .rejects.toThrow(/integrity|sidecar|render/i);

  const second = {
    ...metadata,
    id: "render-sidecar-metadata",
    viewport: "tablet",
    imagePath: join(rootPath, ".design-sharingan", "renders", "session-1", "round-1", "tablet.png"),
  };
  await saveRenderArtifact(rootPath, second, pngBytes());
  await unlink(join(rootPath, ".design-sharingan", "renders", "session-1", "round-1", "tablet.json"));

  await expect(assertRenderArtifactIntegrity(rootPath, second))
    .rejects.toThrow(/metadata|sidecar|render/i);
});

it("rejects duplicate or undersized represented Git status evidence", async () => {
  const revisions: RenderArtifact["sourceRevision"][] = [
    {
      kind: "GIT", available: true, head: "a".repeat(40), branch: "main", status: "CLEAN",
      entries: [], truncated: false, worktreeFingerprint: "b".repeat(64), fileCount: 0,
      requiredPathEvidence: [],
    },
    {
      kind: "GIT", available: true, head: "a".repeat(40), branch: "main", status: "DIRTY",
      entries: [
        { index: "?", workingTree: "?", path: "duplicate.txt" },
        { index: "?", workingTree: "?", path: "duplicate.txt" },
      ],
      truncated: false, worktreeFingerprint: "b".repeat(64), fileCount: 2,
      requiredPathEvidence: [],
    },
    {
      kind: "GIT", available: true, head: "a".repeat(40), branch: "main", status: "DIRTY",
      entries: [
        { index: "?", workingTree: "?", path: "one.txt" },
        { index: "?", workingTree: "?", path: "two.txt" },
      ],
      truncated: false, worktreeFingerprint: "b".repeat(64), fileCount: 1,
      requiredPathEvidence: [],
    },
  ];
  for (const [index, sourceRevision] of revisions.entries()) {
    const rootPath = await temporaryProject();
    await ensureDesignWorkspace(rootPath);
    const metadata: RenderArtifact = {
      id: `render-${index + 1}`,
      sessionId: "session-1",
      roundId: "round-1",
      route: "/",
      viewport: "desktop",
      viewportWidth: 1440,
      viewportHeight: 800,
      imagePath: join(rootPath, ".design-sharingan", "renders", "session-1", "round-1", "desktop.png"),
      capturedAt: "2026-08-25T09:00:00.000Z",
      sourceRevision,
    };
    await expect(saveRenderArtifact(rootPath, metadata, pngBytes())).rejects.toThrow(/source revision/i);
  }
});

it("enforces producer identifier grammar at the render persistence boundary", async () => {
  const cases = [
    { field: "sessionId" as const, value: "session\nforged" },
    { field: "roundId" as const, value: "r".repeat(65) },
    { field: "viewport" as const, value: "-desktop" },
  ];
  for (const [index, invalid] of cases.entries()) {
    const rootPath = await temporaryProject();
    await ensureDesignWorkspace(rootPath);
    const sessionId = invalid.field === "sessionId" ? invalid.value : "session-1";
    const roundId = invalid.field === "roundId" ? invalid.value : "round-1";
    const viewport = invalid.field === "viewport" ? invalid.value : "desktop";
    const metadata: RenderArtifact = {
      id: `render-${index + 1}`,
      sessionId,
      roundId,
      route: "/",
      viewport,
      viewportWidth: 1440,
      viewportHeight: 800,
      imagePath: join(rootPath, ".design-sharingan", "renders", sessionId, roundId, `${viewport}.png`),
      capturedAt: "2026-08-25T09:00:00.000Z",
      sourceRevision: { kind: "UNVERSIONED", available: false, reason: "NOT_A_GIT_WORKSPACE" },
    };
    await expect(saveRenderArtifact(rootPath, metadata, pngBytes())).rejects.toThrow(/identifier|safe|metadata/i);
  }
});

// Production break caught: evidence overwrite or a metadata-write failure can replace history or leave an unbound screenshot orphan.
it("creates an immutable render pair and rolls back the image if metadata creation fails", async () => {
  const rootPath = await temporaryProject();
  const workspacePaths = await ensureDesignWorkspace(rootPath);
  const metadata: RenderArtifact = {
    id: "render-1",
    sessionId: "session-1",
    roundId: "round-1",
    route: "/",
    viewport: "desktop",
    viewportWidth: 1440,
    viewportHeight: 800,
    imagePath: join(rootPath, ".design-sharingan", "renders", "session-1", "round-1", "desktop.png"),
    capturedAt: "2026-08-25T09:00:00.000Z",
    sourceRevision: { kind: "UNVERSIONED", available: false, reason: "NOT_A_GIT_WORKSPACE" },
  };
  const png = pngBytes();
  await saveRenderArtifact(rootPath, metadata, png);
  await expect(saveRenderArtifact(rootPath, metadata, png)).rejects.toThrow(/already exists/i);

  const second = {
    ...metadata,
    id: "render-2",
    viewport: "tablet",
    imagePath: join(rootPath, ".design-sharingan", "renders", "session-1", "round-1", "tablet.png"),
  };
  const metadataDirectory = join(workspacePaths.rendersPath, "session-1", "round-1", "tablet.json");
  await mkdir(metadataDirectory);
  await expect(saveRenderArtifact(rootPath, second, png)).rejects.toThrow();
  await expect(readFile(second.imagePath)).rejects.toThrow();
});

// Production break caught: rollback must not unlink a replacement another process installed after the owned image was created.
it("leaves a concurrently replaced image intact when metadata creation fails", async () => {
  const rootPath = await temporaryProject();
  await ensureDesignWorkspace(rootPath);
  const imagePath = join(rootPath, ".design-sharingan", "renders", "session-1", "round-1", "desktop.png");
  const artifactDirectory = dirname(imagePath);
  const metadata: RenderArtifact = {
    id: "render-race",
    sessionId: "session-1",
    roundId: "round-1",
    route: "/",
    viewport: "desktop",
    viewportWidth: 1440,
    viewportHeight: 800,
    imagePath,
    capturedAt: "2026-08-25T09:00:00.000Z",
    sourceRevision: { kind: "UNVERSIONED", available: false, reason: "NOT_A_GIT_WORKSPACE" },
  };
  await mkdir(artifactDirectory, { recursive: true });
  await mkdir(join(artifactDirectory, "desktop.json"));
  const replacement = pngBytes(1440, 800, 25);
  replacement[24] = 99;

  const replacer = (async () => {
    for (;;) {
      try {
        await lstat(imagePath);
        break;
      } catch {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    await rename(imagePath, join(artifactDirectory, "owned-original.png"));
    await writeFile(imagePath, replacement);
  })();

  await expect(Promise.all([
    saveRenderArtifact(rootPath, metadata, pngBytes()),
    replacer,
  ])).rejects.toThrow();
  expect(new Uint8Array(await readFile(imagePath))).toEqual(replacement);
  expect((await lstat(join(artifactDirectory, "owned-original.png"))).isFile()).toBe(true);
});
