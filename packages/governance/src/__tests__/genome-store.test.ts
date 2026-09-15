import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignGenome, ScreenRecord } from "@design-sharingan/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveGenome,
  governanceIsInitialized,
  initializeGovernance,
  readEvidenceCatalog,
  readDesignDecisions,
  readGenome,
  readScreenRegistry,
  genomePayloadHash,
  parseGovernanceMetadata,
  renderGenome,
  renderDesignDecisions,
  renderScreenRegistry,
  saveDesignDecisions,
  saveScreenRegistry,
  setGenomeApprovalTransactionFaultForTest,
} from "../index";

const roots: string[] = [];

function draftGenome(): DesignGenome {
  return {
    version: "0.1.0",
    status: "DRAFT",
    productIdentity: "A calm local-first design intelligence environment.",
    uxInvariants: ["Keep human decisions explicit."],
    visualInvariants: ["Use one restrained accent."],
    motionRules: ["Reserve motion for state transitions."],
    accessibilityRules: ["Maintain visible focus."],
    componentDNA: ["Use fine rules to separate dense evidence."],
    screenFamilies: ["Project workspaces"],
    contentVoice: ["Calm, technical, and direct."],
    intentionalExceptions: ["Overview may use a wider orientation block."],
    unconfirmedRules: ["Compact density may be preferred on evidence screens."],
  };
}

function screenRecord(): ScreenRecord {
  return {
    id: "screen-overview",
    route: "/overview",
    name: "Overview",
    family: "Project workspaces",
    inheritedRules: ["Keep human decisions explicit."],
    exceptions: ["Overview may use a wider orientation block."],
    requiredStates: ["ready", "needs-configuration"],
    evidence: ["ev_route_overview_01"],
    driftStatus: "NOT_VERIFIED",
  };
}

function evidenceCatalog() {
  return [{
    id: "ev_route_overview_01",
    kind: "ROUTE" as const,
    route: "/overview",
    excerpt: "Authenticated project inspection detected this current route.",
    verifiedClaims: [],
  }];
}

const HUMAN_APPROVAL_RULE = "Keep human decisions explicit.";
const HUMAN_APPROVAL_CLAIM_ID = "claim-human-decisions";
const HUMAN_APPROVAL_EVIDENCE_ID = "ev_render_overview_01";
const HUMAN_APPROVAL_RENDER_ID = "render-overview-01";
const HUMAN_APPROVAL_FINGERPRINT = "a".repeat(64);

function approvalDraftGenome(): DesignGenome {
  return {
    ...draftGenome(),
    uxInvariants: [],
    unconfirmedRules: [HUMAN_APPROVAL_RULE],
  };
}

function approvalEvidenceCatalog() {
  return [{
    id: HUMAN_APPROVAL_EVIDENCE_ID,
    kind: "RENDER" as const,
    route: "/overview",
    excerpt: "Authenticated overview render before explicit Genome approval.",
    verifiedClaims: [],
    authenticatedRenderId: HUMAN_APPROVAL_RENDER_ID,
    renderState: "default",
    renderCapturedAt: "2026-09-08T00:00:00.000Z",
    renderSourceRevisionFingerprint: HUMAN_APPROVAL_FINGERPRINT,
  }];
}

function approvalCitations() {
  return [{
    id: HUMAN_APPROVAL_CLAIM_ID,
    claimType: "RULE" as const,
    category: "UX_INVARIANT" as const,
    statement: HUMAN_APPROVAL_RULE,
    confidence: "UNCONFIRMED" as const,
    requestedConfidence: "CONFIRMED" as const,
    scope: { routes: ["/overview"] },
    evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID],
  }];
}

function acceptedHumanClaim(overrides: Record<string, unknown> = {}) {
  return {
    claimId: HUMAN_APPROVAL_CLAIM_ID,
    claimType: "RULE" as const,
    category: "UX_INVARIANT" as const,
    statement: HUMAN_APPROVAL_RULE,
    evidenceId: HUMAN_APPROVAL_EVIDENCE_ID,
    route: "/overview",
    state: "default",
    authenticatedRenderId: HUMAN_APPROVAL_RENDER_ID,
    sourceRevisionFingerprint: HUMAN_APPROVAL_FINGERPRINT,
    ...overrides,
  };
}

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "design-sharingan-governance-"));
  roots.push(root);
  return realpath(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Genome governance store", () => {
  it("creates project-scoped human-readable governance with canonical metadata", async () => {
    const root = await projectRoot();

    const created = await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [screenRecord()],
      evidenceCatalog: evidenceCatalog(),
      decisions: [],
    });

    expect(created.genome.metadata).toMatchObject({
      kind: "DESIGN_GENOME",
      projectId: "project-a",
      revision: 1,
      status: "DRAFT",
    });
    expect(created.genome.value.status).toBe("DRAFT");
    expect((await readGenome(root, "project-a")).value).toEqual(draftGenome());
    expect((await readScreenRegistry(root, "project-a")).records).toEqual([screenRecord()]);
    expect((await readDesignDecisions(root, "project-a")).decisions).toEqual([]);

    const directory = join(root, "design-governance");
    const markdown = await readFile(join(directory, "DESIGN-GENOME.md"), "utf8");
    expect(markdown).toContain("# Design Genome");
    expect(markdown).toContain("## Unconfirmed Rules");
    expect(markdown).toContain("Compact density may be preferred");
    await expect(readFile(join(directory, "SCREEN-REGISTRY.md"), "utf8")).resolves.toContain(
      "# Screen Registry",
    );
    await expect(readFile(join(directory, "DESIGN-DECISIONS.md"), "utf8")).resolves.toContain(
      "# Design Decisions",
    );
  });

  it("requires explicit local-user approval before the Genome becomes authoritative", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: {
        representative: true,
        routes: ["/overview"],
        evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID],
      },
      claimCitations: approvalCitations(),
    });

    const approved = await approveGenome(root, "project-a", {
      approvedBy: "local-user",
      expectedRevision: 1,
      expectedPayloadHash: createdPayloadHash(
        await readGenome(root, "project-a"),
      ),
      acceptedClaim: acceptedHumanClaim(),
    });

    expect(approved.value.status).toBe("APPROVED");
    expect(approved.metadata).toMatchObject({
      status: "APPROVED",
      revision: 2,
    });
    expect(approved.authority).toBe("AUTHORITATIVE");
    expect(approved.metadata.authority).toMatchObject({
      kind: "GENOME_AUTHORITY",
      approvedBy: "local-user",
      approvedDraftRevision: 1,
      documentRevision: 2,
      projectId: "project-a",
    });
    expect(await readFile(join(root, "design-governance", "DESIGN-GENOME.md"), "utf8"))
      .toContain("**Status:** APPROVED");
  });

  it("promotes only the exact human-approved, render-bound draft claim", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: {
        representative: true,
        routes: ["/overview"],
        evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID],
      },
      claimCitations: approvalCitations(),
    });
    const draft = await readGenome(root, "project-a");
    expect(draft.value.uxInvariants).toEqual([]);
    expect(draft.metadata.claimCitations).toContainEqual(expect.objectContaining({
      id: HUMAN_APPROVAL_CLAIM_ID,
      confidence: "UNCONFIRMED",
    }));

    const approved = await approveGenome(root, "project-a", {
      approvedBy: "local-user",
      expectedRevision: draft.metadata.revision,
      expectedPayloadHash: draft.payloadHash,
      acceptedClaim: acceptedHumanClaim(),
    });

    expect(approved.value.uxInvariants).toEqual([HUMAN_APPROVAL_RULE]);
    expect(approved.value.unconfirmedRules).not.toContain(HUMAN_APPROVAL_RULE);
    expect(approved.metadata.claimCitations).toContainEqual(expect.objectContaining({
      id: HUMAN_APPROVAL_CLAIM_ID,
      confidence: "CONFIRMED",
      evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID],
    }));
    expect(await readEvidenceCatalog(root, "project-a")).toContainEqual(expect.objectContaining({
      id: HUMAN_APPROVAL_EVIDENCE_ID,
      verifiedClaims: [{
        claimType: "RULE",
        category: "UX_INVARIANT",
        statement: HUMAN_APPROVAL_RULE,
        scope: { routes: ["/overview"] },
      }],
    }));
  });

  it("rejects Genome approval when no exact draft claim is selected", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: {
        representative: true,
        routes: ["/overview"],
        evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID],
      },
      claimCitations: approvalCitations(),
    });
    const draft = await readGenome(root, "project-a");

    await expect(approveGenome(root, "project-a", {
      approvedBy: "local-user",
      expectedRevision: draft.metadata.revision,
      expectedPayloadHash: draft.payloadHash,
    } as Parameters<typeof approveGenome>[2])).rejects.toThrow(/claim.*required|select/i);
    expect((await readGenome(root, "project-a")).value.status).toBe("DRAFT");
  });

  it.each([
    ["a forged rule id", { claimId: "claim-forged" }],
    ["mismatched rule text", { statement: "Forged rule." }],
    ["mismatched evidence", { evidenceId: "ev_render_forged_01" }],
    ["mismatched route", { route: "/different" }],
    ["mismatched state", { state: "loading" }],
    ["mismatched render", { authenticatedRenderId: "render-forged-01" }],
    ["stale source revision", { sourceRevisionFingerprint: "b".repeat(64) }],
  ])("fails closed for %s", async (_label, overrides) => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: {
        representative: true,
        routes: ["/overview"],
        evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID],
      },
      claimCitations: approvalCitations(),
    });
    const draft = await readGenome(root, "project-a");

    await expect(approveGenome(root, "project-a", {
      approvedBy: "local-user",
      expectedRevision: draft.metadata.revision,
      expectedPayloadHash: draft.payloadHash,
      acceptedClaim: acceptedHumanClaim(overrides),
    })).rejects.toThrow(/claim|evidence|render|route|state|revision/i);
    expect((await readGenome(root, "project-a")).value.status).toBe("DRAFT");
  });

  it("serializes a bound-claim approval so a claim cannot be reused", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: {
        representative: true,
        routes: ["/overview"],
        evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID],
      },
      claimCitations: approvalCitations(),
    });
    const draft = await readGenome(root, "project-a");
    const request = {
      approvedBy: "local-user" as const,
      expectedRevision: draft.metadata.revision,
      expectedPayloadHash: draft.payloadHash,
      acceptedClaim: acceptedHumanClaim(),
    };
    const results = await Promise.allSettled([
      approveGenome(root, "project-a", request),
      approveGenome(root, "project-a", request),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await readGenome(root, "project-a")).value.uxInvariants).toEqual([HUMAN_APPROVAL_RULE]);
  });

  it("recovers one atomic approval after a crash between catalog and Genome promotion", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: {
        representative: true,
        routes: ["/overview"],
        evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID],
      },
      claimCitations: approvalCitations(),
    });
    const draft = await readGenome(root, "project-a");
    setGenomeApprovalTransactionFaultForTest("after-catalog-before-genome");
    try {
      await expect(approveGenome(root, "project-a", {
        approvedBy: "local-user",
        expectedRevision: draft.metadata.revision,
        expectedPayloadHash: draft.payloadHash,
        acceptedClaim: acceptedHumanClaim(),
      })).rejects.toThrow(/injected.*approval.*fault/i);
    } finally {
      setGenomeApprovalTransactionFaultForTest(undefined);
    }

    const recovered = await readGenome(root, "project-a");
    expect(recovered).toMatchObject({
      authority: "AUTHORITATIVE",
      value: { status: "APPROVED", uxInvariants: [HUMAN_APPROVAL_RULE] },
      metadata: { authority: { acceptedClaim: acceptedHumanClaim() } },
    });
    expect(await readEvidenceCatalog(root, "project-a")).toContainEqual(expect.objectContaining({
      id: HUMAN_APPROVAL_EVIDENCE_ID,
      verifiedClaims: [expect.objectContaining({ statement: HUMAN_APPROVAL_RULE })],
    }));
  });

  it("recovers an authenticated approval transaction when its pointer is missing", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: { representative: true, routes: ["/overview"], evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID] },
      claimCitations: approvalCitations(),
    });
    const draft = await readGenome(root, "project-a");
    setGenomeApprovalTransactionFaultForTest("after-catalog-before-genome");
    try {
      await expect(approveGenome(root, "project-a", {
        approvedBy: "local-user",
        expectedRevision: draft.metadata.revision,
        expectedPayloadHash: draft.payloadHash,
        acceptedClaim: acceptedHumanClaim(),
      })).rejects.toThrow(/injected/i);
    } finally {
      setGenomeApprovalTransactionFaultForTest(undefined);
    }
    await unlink(join(root, ".design-sharingan", "pending-genome-approval.json"));

    await expect(readGenome(root, "project-a")).resolves.toMatchObject({
      authority: "AUTHORITATIVE",
      value: { status: "APPROVED", uxInvariants: [HUMAN_APPROVAL_RULE] },
    });
  });

  it("rejects replay of a consumed approval transaction over intervening governance", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: { representative: true, routes: ["/overview"], evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID] },
      claimCitations: approvalCitations(),
    });
    const draft = await readGenome(root, "project-a");
    setGenomeApprovalTransactionFaultForTest("after-catalog-before-genome");
    try {
      await expect(approveGenome(root, "project-a", {
        approvedBy: "local-user",
        expectedRevision: draft.metadata.revision,
        expectedPayloadHash: draft.payloadHash,
        acceptedClaim: acceptedHumanClaim(),
      })).rejects.toThrow(/injected/i);
    } finally {
      setGenomeApprovalTransactionFaultForTest(undefined);
    }
    const machine = join(root, ".design-sharingan");
    const staging = join(machine, "genome-approval-transaction");
    const saved = {
      pointer: await readFile(join(machine, "pending-genome-approval.json"), "utf8"),
      manifest: await readFile(join(staging, "approval-transaction.json"), "utf8"),
      genome: await readFile(join(staging, "DESIGN-GENOME.md"), "utf8"),
      catalog: await readFile(join(staging, "governance-evidence.json"), "utf8"),
    };
    await readGenome(root, "project-a");
    const genomePath = join(root, "design-governance", "DESIGN-GENOME.md");
    const intervening = `${await readFile(genomePath, "utf8")}\n`;
    await writeFile(genomePath, intervening);
    await mkdir(staging, { mode: 0o700 });
    await writeFile(join(staging, "approval-transaction.json"), saved.manifest);
    await writeFile(join(staging, "DESIGN-GENOME.md"), saved.genome);
    await writeFile(join(staging, "governance-evidence.json"), saved.catalog);
    await writeFile(join(machine, "pending-genome-approval.json"), saved.pointer);

    await expect(readGenome(root, "project-a")).rejects.toThrow(/replay|intervening|transaction/i);
    expect(await readFile(genomePath, "utf8")).toBe(intervening);
  });

  it("fails closed for a symlinked approval staging directory", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: { representative: true, routes: ["/overview"], evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID] },
      claimCitations: approvalCitations(),
    });
    const outside = await projectRoot();
    const marker = join(outside, "preserve.txt");
    await writeFile(marker, "preserve");
    await symlink(outside, join(root, ".design-sharingan", "genome-approval-transaction"));

    await expect(readGenome(root, "project-a")).rejects.toThrow(/outside|staging.*unsafe|symbolic link/i);
    expect(await readFile(marker, "utf8")).toBe("preserve");
  });

  it.each([
    ["empty", []],
    ["after the Genome payload", ["DESIGN-GENOME.md"]],
    ["after both payloads", ["DESIGN-GENOME.md", "governance-evidence.json"]],
  ])("cleans validated pre-commit approval residue %s", async (_label, files) => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: { representative: true, routes: ["/overview"], evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID] },
      claimCitations: approvalCitations(),
    });
    const staging = join(root, ".design-sharingan", "genome-approval-transaction");
    await mkdir(staging, { mode: 0o700 });
    for (const file of files) await writeFile(join(staging, file), "pre-commit residue");

    await expect(readGenome(root, "project-a")).resolves.toMatchObject({ value: { status: "DRAFT" } });
    await expect(realpath(staging)).rejects.toThrow(/ENOENT/);
  });

  it("recovers when pointer publication succeeds but its caller observes an error", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: { representative: true, routes: ["/overview"], evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID] },
      claimCitations: approvalCitations(),
    });
    const draft = await readGenome(root, "project-a");
    setGenomeApprovalTransactionFaultForTest("after-pointer-publish-before-return");
    try {
      await expect(approveGenome(root, "project-a", {
        approvedBy: "local-user",
        expectedRevision: draft.metadata.revision,
        expectedPayloadHash: draft.payloadHash,
        acceptedClaim: acceptedHumanClaim(),
      })).rejects.toThrow(/injected/i);
    } finally {
      setGenomeApprovalTransactionFaultForTest(undefined);
    }

    await expect(readGenome(root, "project-a")).resolves.toMatchObject({
      authority: "AUTHORITATIVE",
      value: { status: "APPROVED", uxInvariants: [HUMAN_APPROVAL_RULE] },
    });
  });

  it("rejects a claim whose evidence is shared by another draft candidate", async () => {
    const root = await projectRoot();
    const sharedRule = "Keep the approved screen hierarchy stable.";
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: {
        ...approvalDraftGenome(),
        unconfirmedRules: [HUMAN_APPROVAL_RULE, sharedRule],
      },
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: {
        representative: true,
        routes: ["/overview"],
        evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID],
      },
      claimCitations: [
        ...approvalCitations(),
        {
          ...approvalCitations()[0]!,
          id: "claim-shared-evidence",
          statement: sharedRule,
        },
      ],
    });
    const draft = await readGenome(root, "project-a");

    await expect(approveGenome(root, "project-a", {
      approvedBy: "local-user",
      expectedRevision: draft.metadata.revision,
      expectedPayloadHash: draft.payloadHash,
      acceptedClaim: acceptedHumanClaim(),
    })).rejects.toThrow(/shared/i);
    expect((await readGenome(root, "project-a")).value.status).toBe("DRAFT");
  });

  it("rejects semantically duplicate draft claims even when their ids and evidence differ", async () => {
    const root = await projectRoot();
    const secondEvidenceId = "ev_render_overview_02";
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: [
        ...approvalEvidenceCatalog(),
        { ...approvalEvidenceCatalog()[0]!, id: secondEvidenceId, authenticatedRenderId: "render-overview-02" },
      ],
      inspectedScope: {
        representative: true,
        routes: ["/overview"],
        evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID, secondEvidenceId],
      },
      claimCitations: [
        ...approvalCitations(),
        { ...approvalCitations()[0]!, id: "claim-human-decisions-alias", evidenceIds: [secondEvidenceId] },
      ],
    })).rejects.toThrow(/semantic|equivalent|duplicate/i);
  });

  it("rejects reuse of a rule already verified anywhere in the signed catalog", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog().map((entry) => ({
        ...entry,
        verifiedClaims: [{
          claimType: "RULE" as const,
          category: "UX_INVARIANT" as const,
          statement: HUMAN_APPROVAL_RULE,
          scope: { routes: ["/overview"] },
        }],
      })),
      inspectedScope: {
        representative: true,
        routes: ["/overview"],
        evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID],
      },
      claimCitations: approvalCitations(),
    });
    const draft = await readGenome(root, "project-a");

    await expect(approveGenome(root, "project-a", {
      approvedBy: "local-user",
      expectedRevision: draft.metadata.revision,
      expectedPayloadHash: draft.payloadHash,
      acceptedClaim: acceptedHumanClaim(),
    })).rejects.toThrow(/already been used/i);
    expect((await readGenome(root, "project-a")).value.status).toBe("DRAFT");
  });

  it("serializes concurrent approval and rejects stale revisions", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: {
        representative: true,
        routes: ["/overview"],
        evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID],
      },
      claimCitations: approvalCitations(),
    });

    const results = await Promise.allSettled([
      approveGenome(root, "project-a", {
        approvedBy: "local-user",
        expectedRevision: 1,
        expectedPayloadHash: createdPayloadHash(await readGenome(root, "project-a")),
        acceptedClaim: acceptedHumanClaim(),
      }),
      approveGenome(root, "project-a", {
        approvedBy: "local-user",
        expectedRevision: 1,
        expectedPayloadHash: createdPayloadHash(await readGenome(root, "project-a")),
        acceptedClaim: acceptedHumanClaim(),
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await readGenome(root, "project-a")).metadata.revision).toBe(2);
  });

  it("atomically serializes concurrent three-document initialization", async () => {
    const root = await projectRoot();
    const input = {
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [screenRecord()],
      evidenceCatalog: evidenceCatalog(),
      decisions: [],
    };
    const results = await Promise.allSettled([
      initializeGovernance(input),
      initializeGovernance(input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(governanceIsInitialized(root)).resolves.toBe(true);
    await expect(readGenome(root, "project-a")).resolves.toMatchObject({
      authority: "NON_AUTHORITATIVE",
      value: { status: "DRAFT" },
    });
  });

  it("pre-renders all documents and leaves no partial governance for an oversized Registry", async () => {
    const root = await projectRoot();
    const records = Array.from({ length: 32 }, (_, index) => ({
      ...screenRecord(),
      id: `screen-${index}`,
      route: `/route-${index}`,
      evidence: [`ev_route_${String(index).padStart(8, "0")}`],
      requiredStates: Array.from({ length: 64 }, (__, state) => `${state}-${"x".repeat(990)}`),
    }));
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: records,
      evidenceCatalog: records.map((record) => ({
        id: record.evidence[0]!,
        kind: "ROUTE" as const,
        route: record.route,
        excerpt: "Authenticated route evidence.",
        verifiedClaims: [],
      })),
      decisions: [],
    })).rejects.toThrow(/256 KiB/i);
    await expect(governanceIsInitialized(root)).resolves.toBe(false);
  });

  it("recovers only an owned stale lock and owned crash staging residue", async () => {
    const root = await projectRoot();
    const machine = join(root, ".design-sharingan");
    const staging = join(machine, "governance-staging");
    const owner = "11111111-1111-4111-8111-111111111111";
    const ownerDirectory = join(staging, owner);
    await mkdir(join(ownerDirectory, "payload"), { recursive: true });
    await writeFile(join(ownerDirectory, "manifest.json"), JSON.stringify({
      kind: "DESIGN_SHARINGAN_GOVERNANCE_INIT",
      owner,
      pid: 999_999_999,
      projectId: "project-a",
      createdAt: "2000-01-01T00:00:00.000Z",
      files: ["DESIGN-GENOME.md", "SCREEN-REGISTRY.md", "DESIGN-DECISIONS.md"],
    }));
    await writeFile(join(ownerDirectory, "payload", "orphan.tmp"), "owned residue");
    await writeFile(join(machine, "governance.lock"), JSON.stringify({
      kind: "DESIGN_SHARINGAN_GOVERNANCE_LOCK",
      owner: "22222222-2222-4222-8222-222222222222",
      pid: 999_999_999,
      createdAt: "2000-01-01T00:00:00.000Z",
    }));

    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    });
    await expect(readFile(join(ownerDirectory, "manifest.json"), "utf8")).rejects.toThrow();
    await expect(governanceIsInitialized(root)).resolves.toBe(true);
  });

  it("never reclaims an ambiguous live lock claim", async () => {
    const root = await projectRoot();
    const machine = join(root, ".design-sharingan");
    await mkdir(machine);
    await writeFile(join(machine, "governance.lock"), JSON.stringify({
      kind: "DESIGN_SHARINGAN_GOVERNANCE_LOCK",
      owner: "33333333-3333-4333-8333-333333333333",
      pid: process.pid,
      createdAt: "2000-01-01T00:00:00.000Z",
    }));
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    })).rejects.toThrow(/busy/i);
    await expect(readFile(join(machine, "governance.lock"), "utf8")).resolves.toContain(
      "33333333-3333-4333-8333-333333333333",
    );
  });

  it("fails closed for a symlinked governance directory", async () => {
    const root = await projectRoot();
    const outside = await projectRoot();
    await symlink(outside, join(root, "design-governance"));

    await expect(
      initializeGovernance({
        rootPath: root,
        projectId: "project-a",
        genome: draftGenome(),
        screens: [],
        decisions: [],
      }),
    ).rejects.toThrow(/symbolic link/i);
  });

  it("rejects a symlink alias instead of treating it as a canonical project root", async () => {
    const target = await projectRoot();
    const aliasParent = await projectRoot();
    const alias = join(aliasParent, "project-alias");
    await symlink(target, alias);

    await expect(
      initializeGovernance({
        rootPath: alias,
        projectId: "project-a",
        genome: draftGenome(),
        screens: [],
        decisions: [],
      }),
    ).rejects.toThrow(/canonical project root/i);
  });

  it("fails closed for hardlinked governance documents", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    });
    const genomePath = join(root, "design-governance", "DESIGN-GENOME.md");
    const payloadHash = createdPayloadHash(await readGenome(root, "project-a"));
    await link(genomePath, join(root, "genome-copy.md"));

    await expect(readGenome(root, "project-a")).rejects.toThrow(/hard link/i);
    await expect(
      approveGenome(root, "project-a", {
        approvedBy: "local-user",
        expectedRevision: 1,
        expectedPayloadHash: payloadHash,
        acceptedClaim: acceptedHumanClaim(),
      }),
    ).rejects.toThrow(/hard link/i);
  });

  it("rejects governance metadata belonging to another project", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    });

    await expect(readGenome(root, "project-b")).rejects.toThrow(/project identity/i);
  });

  it("rejects a stale approval when the exact draft payload hash is not presented", async () => {
    const root = await projectRoot();
    const created = await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    });

    await expect(
      approveGenome(root, "project-a", {
        approvedBy: "local-user",
        expectedRevision: created.genome.metadata.revision,
        expectedPayloadHash: "0".repeat(64),
        acceptedClaim: acceptedHumanClaim(),
      }),
    ).rejects.toThrow(/payload.*stale|hash.*stale/i);
    expect((await readGenome(root, "project-a")).value.status).toBe("DRAFT");
  });

  it("rejects forged actor, time, status, content, project, revision, root, and hash authority", async () => {
    const root = await projectRoot();
    const created = await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: {
        representative: true,
        routes: ["/overview"],
        evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID],
      },
      claimCitations: approvalCitations(),
    });
    await approveGenome(root, "project-a", {
      approvedBy: "local-user",
      expectedRevision: 1,
      expectedPayloadHash: created.genome.payloadHash,
      acceptedClaim: acceptedHumanClaim(),
    });
    const path = join(root, "design-governance", "DESIGN-GENOME.md");
    const original = parseGovernanceMetadata(await readFile(path, "utf8"));
    if (original.kind !== "DESIGN_GENOME" || original.authority === undefined) {
      throw new Error("test fixture lacks authority");
    }
    const genomeMetadata = original;
    const mutations: Array<(metadata: typeof genomeMetadata) => void> = [
      (metadata) => { (metadata.authority as { approvedBy: string }).approvedBy = "agent"; },
      (metadata) => { metadata.authority!.approvedAt = "yesterday"; },
      (metadata) => { metadata.value.status = "DRAFT"; metadata.status = "DRAFT"; },
      (metadata) => {
        metadata.value.uxInvariants = ["Forged exact rule."];
        metadata.authority!.payloadHash = genomePayloadHash(metadata.value);
      },
      (metadata) => { metadata.projectId = "project-b"; metadata.authority!.projectId = "project-b"; },
      (metadata) => { metadata.authority!.documentRevision = 9; },
      (metadata) => { metadata.authority!.rootFingerprint = "1".repeat(64); },
      (metadata) => { metadata.authority!.payloadHash = "2".repeat(64); },
    ];
    for (const mutate of mutations) {
      const forged = structuredClone(genomeMetadata);
      mutate(forged);
      await writeFile(path, renderGenome(forged));
      await expect(readGenome(root, forged.projectId)).rejects.toThrow();
    }
  });

  it("rejects an approved Genome whose signed claim no longer matches its confirmed citation", async () => {
    const root = await projectRoot();
    const created = await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: {
        representative: true,
        routes: ["/overview"],
        evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID],
      },
      claimCitations: approvalCitations(),
    });
    await approveGenome(root, "project-a", {
      approvedBy: "local-user",
      expectedRevision: 1,
      expectedPayloadHash: created.genome.payloadHash,
      acceptedClaim: acceptedHumanClaim(),
    });
    const path = join(root, "design-governance", "DESIGN-GENOME.md");
    const original = parseGovernanceMetadata(await readFile(path, "utf8"));
    if (original.kind !== "DESIGN_GENOME") throw new Error("test fixture lacks Genome metadata");
    type ParsedGenome = Extract<ReturnType<typeof parseGovernanceMetadata>, { kind: "DESIGN_GENOME" }>;
    const mutations: Array<(metadata: ParsedGenome) => void> = [
      (metadata) => { metadata.claimCitations[0]!.id = "claim-substituted"; },
      (metadata) => { metadata.claimCitations[0]!.confidence = "UNCONFIRMED"; },
      (metadata) => { metadata.claimCitations = []; },
    ];
    for (const mutate of mutations) {
      const forged = structuredClone(original);
      mutate(forged);
      await writeFile(path, renderGenome(forged));
      await expect(readGenome(root, "project-a")).rejects.toThrow(/accepted|citation|claim|authority/i);
    }
  });

  it("rejects canonical Markdown body tampering and duplicate metadata", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    });
    const path = join(root, "design-governance", "DESIGN-GENOME.md");
    const canonical = await readFile(path, "utf8");
    await writeFile(path, canonical.replace("Keep human decisions explicit.", "Silent mutation."));
    await expect(readGenome(root, "project-a")).rejects.toThrow(/canonical|body|mismatch/i);

    await writeFile(path, `${canonical.split("\n")[0]}\n${canonical}`);
    await expect(readGenome(root, "project-a")).rejects.toThrow(/canonical|metadata/i);
  });

  it("round-trips Unicode, newlines, and Markdown structural characters canonically", async () => {
    const root = await projectRoot();
    const unusual = draftGenome();
    unusual.productIdentity = "道具 — line one\n# not a heading <script> -- **literal**";
    unusual.uxInvariants = ["- not a list\n## not a heading `code` 👁️"];
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: unusual,
      screens: [],
      decisions: [],
    });
    expect((await readGenome(root, "project-a")).value).toEqual(unusual);
  });

  it("reads a canonical schema-v1 draft whose legacy citations predate stable claim ids", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: approvalDraftGenome(),
      screens: [],
      decisions: [],
      evidenceCatalog: approvalEvidenceCatalog(),
      inspectedScope: {
        representative: true,
        routes: ["/overview"],
        evidenceIds: [HUMAN_APPROVAL_EVIDENCE_ID],
      },
      claimCitations: approvalCitations(),
    });
    const path = join(root, "design-governance", "DESIGN-GENOME.md");
    const legacy = await readFile(
      new URL("./fixtures/design-genome-schema-v1-pre-claim-id.md", import.meta.url),
      "utf8",
    );
    await writeFile(path, legacy);

    const migrated = await readGenome(root, "project-a");
    expect(migrated).toMatchObject({
      value: { status: "DRAFT" },
      metadata: {
        schemaVersion: 1,
        claimCitations: [expect.objectContaining({
          id: expect.stringMatching(/^claim-[a-f0-9]{32}$/),
          statement: HUMAN_APPROVAL_RULE,
        })],
      },
    });
    const migratedClaim = migrated.metadata.claimCitations[0]!;
    const approved = await approveGenome(root, "project-a", {
      approvedBy: "local-user",
      expectedRevision: migrated.metadata.revision,
      expectedPayloadHash: migrated.payloadHash,
      acceptedClaim: {
        ...acceptedHumanClaim(),
        claimId: migratedClaim.id,
      },
    });
    expect(approved).toMatchObject({
      value: { status: "APPROVED", uxInvariants: [HUMAN_APPROVAL_RULE] },
      metadata: {
        revision: 2,
        claimCitations: [expect.objectContaining({
          id: migratedClaim.id,
          confidence: "CONFIRMED",
        })],
      },
    });
    expect(await readFile(path, "utf8")).toContain(`\"id\":\"${migratedClaim.id}\"`);
  });

  it("rejects unsafe, duplicate, and relation-invalid Screen Registry records", async () => {
    const root = await projectRoot();
    const invalid = screenRecord();
    invalid.route = "/overview/../secrets";
    invalid.family = "Unknown family";
    invalid.driftStatus = "PASS";
    invalid.lastVerified = "yesterday";
    await expect(
      initializeGovernance({
        rootPath: root,
        projectId: "project-a",
        genome: draftGenome(),
        screens: [invalid, { ...invalid, id: "screen-other" }],
        evidenceCatalog: evidenceCatalog(),
        decisions: [],
      }),
    ).rejects.toThrow(/route|family|verification|unique/i);
  });

  it("rejects encoded traversal routes and unauthenticated verification claims", async () => {
    const root = await projectRoot();
    const invalid = screenRecord();
    invalid.route = "/%2e%2e/private";
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [invalid],
      evidenceCatalog: evidenceCatalog(),
      decisions: [],
    })).rejects.toThrow(/route/i);
    const ungrounded = screenRecord();
    ungrounded.driftStatus = "PASS";
    ungrounded.lastVerified = "2026-08-30T00:00:00.000Z";
    ungrounded.evidence = [];
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [ungrounded],
      evidenceCatalog: evidenceCatalog(),
      decisions: [],
    })).rejects.toThrow(/evidence|verification/i);
    const unauthenticatedPass = screenRecord();
    unauthenticatedPass.driftStatus = "PASS";
    unauthenticatedPass.lastVerified = "2026-08-30T00:00:00.000Z";
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [unauthenticatedPass],
      evidenceCatalog: evidenceCatalog(),
      decisions: [],
    })).rejects.toThrow(/remains NOT_VERIFIED|authenticated verification/i);
  });

  it("enforces exact Design Decision actor, status, time, and consequential-change proof", async () => {
    const root = await projectRoot();
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [],
      decisions: [{
        id: "decision-1",
        date: "not-a-time",
        status: "APPROVED",
        scope: "Genome",
        decision: "Rewrite the Genome.",
        reason: "Agent preference.",
        alternatives: [],
        affectedScreens: [],
        affectedComponents: [],
        migrationRequired: true,
        genomeChanges: ["Replace an invariant."],
        approvedBy: "agent" as never,
      }],
    })).rejects.toThrow(/ISO|proof|status|local-user/i);
  });

  it("rejects a canonically rewritten Registry linked to another Genome", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [screenRecord()],
      evidenceCatalog: evidenceCatalog(),
      decisions: [],
    });
    const path = join(root, "design-governance", "SCREEN-REGISTRY.md");
    const registry = parseGovernanceMetadata(await readFile(path, "utf8"));
    if (registry.kind !== "SCREEN_REGISTRY") throw new Error("test Registry kind changed");
    registry.genomeEntityId = "foreign-genome";
    await writeFile(path, renderScreenRegistry(registry));
    await expect(readScreenRegistry(root, "project-a")).rejects.toThrow(/active Design Genome/i);
  });

  it("recovers stale zero-byte and partial crash lock claims but preserves a recent incomplete claim", async () => {
    for (const [name, content] of [["zero", ""], ["partial", '{"kind":']] as const) {
      const root = await projectRoot();
      const machine = join(root, ".design-sharingan");
      await mkdir(machine);
      const lock = join(machine, "governance.lock");
      await writeFile(lock, content);
      await utimes(lock, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));

      await expect(initializeGovernance({
        rootPath: root,
        projectId: `project-${name}`,
        genome: draftGenome(),
        screens: [],
        decisions: [],
      })).resolves.toBeDefined();
    }

    const liveRoot = await projectRoot();
    const liveMachine = join(liveRoot, ".design-sharingan");
    await mkdir(liveMachine);
    await writeFile(join(liveMachine, "governance.lock"), "");
    await expect(initializeGovernance({
      rootPath: liveRoot,
      projectId: "project-live",
      genome: draftGenome(),
      screens: [],
      decisions: [],
    })).rejects.toThrow(/busy/i);
  });

  it.each([
    "/a%2Fb",
    "/a%5Cb",
    "/a%3Fb",
    "/a%23b",
    "/%2e/private",
    "/a?query=1",
    "/a#fragment",
    "/%252e%252e/private",
    "/a%252Fb",
    "/a%255Cb",
    "/a%253Fb",
    "/a%2523b",
  ])("rejects ambiguous or noncanonical route %s", async (route) => {
    const root = await projectRoot();
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [{ ...screenRecord(), route }],
      evidenceCatalog: [{ ...evidenceCatalog()[0]!, route }],
      decisions: [],
    })).rejects.toThrow(/route/i);
  });

  it("canonicalizes unreserved route encoding before enforcing route uniqueness", async () => {
    const root = await projectRoot();
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [
        { ...screenRecord(), id: "screen-a", route: "/over%76iew" },
        { ...screenRecord(), id: "screen-b", route: "/overview" },
      ],
      evidenceCatalog: evidenceCatalog(),
      decisions: [],
    })).rejects.toThrow(/routes must be unique/i);
  });

  it("normalizes canonically equivalent Unicode routes before uniqueness checks", async () => {
    const root = await projectRoot();
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [
        {
          ...screenRecord(),
          id: "screen-a",
          route: "/caf%C3%A9",
          evidence: ["ev_route_overview_01"],
        },
        {
          ...screenRecord(),
          id: "screen-b",
          route: "/cafe%CC%81",
          evidence: ["ev_route_unicode_0002"],
        },
      ],
      evidenceCatalog: [
        { ...evidenceCatalog()[0]!, route: "/caf%C3%A9" },
        {
          ...evidenceCatalog()[0]!,
          id: "ev_route_unicode_0002",
          route: "/cafe%CC%81",
        },
      ],
      decisions: [],
    })).rejects.toThrow(/routes must be unique/i);
  });

  it("authenticates Registry evidence against the durable server catalog", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [screenRecord()],
      evidenceCatalog: evidenceCatalog(),
      decisions: [],
    });
    const catalogPath = join(root, ".design-sharingan", "governance-evidence.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
      entries: Array<{ id: string }>;
    };
    catalog.entries[0]!.id = "ev_attacker_forged_01";
    await writeFile(catalogPath, JSON.stringify(catalog));

    await expect(readScreenRegistry(root, "project-a")).rejects.toThrow(/evidence catalog|signature|authenticated/i);
  });

  it("rejects Registry evidence that is not present in the durable catalog", async () => {
    const root = await projectRoot();
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [screenRecord()],
      evidenceCatalog: [],
      decisions: [],
    })).rejects.toThrow(/evidence catalog/i);
  });

  it("rejects a Registry citation scoped to a different catalog route", async () => {
    const root = await projectRoot();
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [screenRecord()],
      evidenceCatalog: [{ ...evidenceCatalog()[0]!, route: "/different" }],
      inspectedScope: {
        representative: true,
        routes: ["/different"],
        evidenceIds: ["ev_route_overview_01"],
      },
      decisions: [],
    })).rejects.toThrow(/evidence.*route|route.*evidence/i);
  });

  it("requires every Decision screen reference to match a canonical Registry id or route", async () => {
    const root = await projectRoot();
    await expect(initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [screenRecord()],
      evidenceCatalog: evidenceCatalog(),
      decisions: [{
        id: "decision-1",
        date: "2026-08-31T00:00:00.000Z",
        status: "DRAFT",
        scope: "Overview",
        decision: "Consider a scoped layout change.",
        reason: "Needs local review.",
        alternatives: [],
        affectedScreens: ["/unknown"],
        affectedComponents: [],
        migrationRequired: false,
        genomeChanges: [],
      }],
    })).rejects.toThrow(/registered screen/i);
  });

  it("rejects forged Registry catalog citations even when canonical Markdown is regenerated", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [screenRecord()],
      evidenceCatalog: evidenceCatalog(),
      decisions: [],
    });
    const path = join(root, "design-governance", "SCREEN-REGISTRY.md");
    const registry = parseGovernanceMetadata(await readFile(path, "utf8"));
    if (registry.kind !== "SCREEN_REGISTRY") throw new Error("test Registry kind changed");
    registry.evidenceIds.push("ev_attacker_forged_01");
    await writeFile(path, renderScreenRegistry(registry));

    await expect(readScreenRegistry(root, "project-a")).rejects.toThrow(/evidence catalog|authenticated/i);
  });

  it("validates Decision screen relations on both writer and loader", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [screenRecord()],
      evidenceCatalog: evidenceCatalog(),
      decisions: [],
    });
    const invalidDecision = {
      id: "decision-1",
      date: "2026-08-31T00:00:00.000Z",
      status: "DRAFT" as const,
      scope: "Overview",
      decision: "Consider a scoped layout change.",
      reason: "Needs local review.",
      alternatives: [],
      affectedScreens: ["/unknown"],
      affectedComponents: [],
      migrationRequired: false,
      genomeChanges: [],
    };
    await expect(saveDesignDecisions(root, "project-a", [invalidDecision], 1))
      .rejects.toThrow(/registered screen/i);

    const path = join(root, "design-governance", "DESIGN-DECISIONS.md");
    const decisions = parseGovernanceMetadata(await readFile(path, "utf8"));
    if (decisions.kind !== "DESIGN_DECISIONS") throw new Error("test Decisions kind changed");
    decisions.decisions = [invalidDecision];
    await writeFile(path, renderDesignDecisions(decisions));
    await expect(readDesignDecisions(root, "project-a")).rejects.toThrow(/registered screen/i);
  });

  it("rejects revision overflow instead of producing an unsafe increment", async () => {
    const root = await projectRoot();
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: draftGenome(),
      screens: [screenRecord()],
      evidenceCatalog: evidenceCatalog(),
      decisions: [],
    });
    const path = join(root, "design-governance", "SCREEN-REGISTRY.md");
    const registry = parseGovernanceMetadata(await readFile(path, "utf8"));
    if (registry.kind !== "SCREEN_REGISTRY") throw new Error("test Registry kind changed");
    registry.revision = Number.MAX_SAFE_INTEGER;
    await writeFile(path, renderScreenRegistry(registry));

    await expect(saveScreenRegistry(
      root,
      "project-a",
      [screenRecord()],
      Number.MAX_SAFE_INTEGER,
    )).rejects.toThrow(/revision.*maximum|increment/i);
  });
});

function createdPayloadHash(document: Awaited<ReturnType<typeof readGenome>>): string {
  return document.payloadHash;
}
