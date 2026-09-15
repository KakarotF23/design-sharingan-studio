import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignGenome, ScreenRecord } from "@design-sharingan/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveGenome,
  incrementAuditGenerationSequence,
  initializeGovernance,
  readEvidenceCatalog,
  readDriftReport,
  readGenome,
  readScreenRegistry,
  saveDriftReport,
  saveScreenRegistry,
  setAuditTransactionFaultForTest,
} from "../index";
import { parseGovernanceMetadata, renderDriftReport, renderScreenRegistry } from "../templates";
import { saveGovernanceCaptureSession, saveProjectMetadata, saveRenderArtifact } from "@design-sharingan/project-adapters";
import * as governance from "../index";

const roots: string[] = [];

function genome(): DesignGenome {
  return {
    version: "0.1.0",
    status: "DRAFT",
    productIdentity: "A calm local-first design intelligence environment.",
    uxInvariants: [],
    visualInvariants: [],
    motionRules: [],
    accessibilityRules: ["Maintain visible focus."],
    componentDNA: [],
    screenFamilies: ["Project workspaces"],
    contentVoice: [],
    intentionalExceptions: [],
    unconfirmedRules: ["Keep human decisions explicit."],
  };
}

function screen(): ScreenRecord {
  return {
    id: "screen-overview",
    route: "/overview",
    name: "Overview",
    family: "Project workspaces",
    inheritedRules: [],
    exceptions: [],
    requiredStates: ["default"],
    evidence: ["ev_route_overview_01"],
    driftStatus: "NOT_VERIFIED",
  };
}

function unavailableReport() {
  return {
    requestedScope: "SELECTED_SCREENS" as const,
    expectedScope: [{ screen: "/overview", states: ["default"] }],
    inspectedScope: [],
    unavailableScope: ["/overview#default: No authenticated render."],
    unverifiedScope: ["/overview#default: No authenticated render."],
    evidenceIds: [],
    findings: [],
    overallStatus: "NOT_VERIFIED" as const,
  };
}

async function initializeDraft(rootPath: string): Promise<void> {
  await initializeGovernance({
    rootPath,
    projectId: "project-a",
    genome: genome(),
    screens: [screen()],
    decisions: [],
    evidenceCatalog: [{
      id: "ev_route_overview_01",
      kind: "RENDER",
      route: "/overview",
      excerpt: "Authenticated overview render.",
      verifiedClaims: [],
      authenticatedRenderId: "render-overview-01",
      renderState: "default",
      renderCapturedAt: "2026-09-08T00:00:00.000Z",
      renderSourceRevisionFingerprint: "a".repeat(64),
    }],
    claimCitations: [{
      id: "claim-human-decisions",
      claimType: "RULE",
      category: "UX_INVARIANT",
      statement: "Keep human decisions explicit.",
      confidence: "UNCONFIRMED",
      requestedConfidence: "CONFIRMED",
      scope: { routes: ["/overview"] },
      evidenceIds: ["ev_route_overview_01"],
    }],
  });
}

async function initialize(rootPath: string): Promise<void> {
  await initializeDraft(rootPath);
  const draft = await readGenome(rootPath, "project-a");
  await approveGenome(rootPath, "project-a", {
    approvedBy: "local-user",
    expectedRevision: draft.metadata.revision,
    expectedPayloadHash: draft.payloadHash,
    acceptedClaim: {
      claimId: "claim-human-decisions",
      claimType: "RULE",
      category: "UX_INVARIANT",
      statement: "Keep human decisions explicit.",
      evidenceId: "ev_route_overview_01",
      route: "/overview",
      state: "default",
      authenticatedRenderId: "render-overview-01",
      sourceRevisionFingerprint: "a".repeat(64),
    },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Drift Report governance store", () => {
  it("rejects persistence when the current Genome is only a draft rather than an authoritative attestation", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-draft-genome-")));
    roots.push(root);
    await initializeDraft(root);

    await expect(saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [],
      report: unavailableReport(),
    })).rejects.toThrow(/authoritative.*Genome|approved.*Genome/i);
  });

  // Production break: even an exact authenticated render/check/Genome proof is unconditionally refused as a clean scoped audit.
  // Production break: there is no authenticated human decision writer for permitted non-blocking polish debt.
  it("records a signed non-Genome-changing human decision and rejects consequential changes", async () => {
    expect(governance).toHaveProperty("recordApprovedNonConsequentialDecision");
    const root = await realpath(await mkdtemp(join(tmpdir(), "polish-decision-"))); roots.push(root); await initialize(root);
    const at = new Date().toISOString();
    const decision = { id: "debt-polish-1", date: at, status: "APPROVED" as const, scope: "/overview#default", decision: "Accept polish debt: /overview#default: Refine spacing", reason: "Release can proceed while spacing is tracked.", alternatives: ["Fix now"], affectedScreens: ["/overview"], affectedComponents: [], migrationRequired: false, genomeChanges: [], approvedBy: "local-user" as const };
    await governance.recordApprovedNonConsequentialDecision(root, "project-a", decision, 1);
    expect((await governance.readDesignDecisions(root, "project-a")).decisions).toContainEqual(decision);
    await expect(governance.recordApprovedNonConsequentialDecision(root, "project-a", { ...decision, id: "debt-polish-2", genomeChanges: ["Rewrite Genome"] }, 2)).rejects.toThrow(/consequential/);
  });

  it("persists a clean scoped PASS only with a matching durable capture proof", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-proof-"))); roots.push(root); await initialize(root);
    const at = new Date().toISOString();
    await saveProjectMetadata({ id: "project-a", rootPath: root, name: "Proof", sourceType: "LOCAL", status: "READY", createdAt: at, updatedAt: at });
    const approved = await readGenome(root, "project-a");
    const render = { id: "render-proof", sessionId: "capture-proof", roundId: "capture", route: "/overview", viewport: "desktop", viewportWidth: 240, viewportHeight: 240, imagePath: join(root, ".design-sharingan/renders/capture-proof/capture/desktop.png"), capturedAt: at, sourceRevision: { kind: "UNVERSIONED" as const, available: true as const, truncated: false as const, worktreeFingerprint: "a".repeat(64), fileCount: 1, requiredPathEvidence: [] } };
    const png = Buffer.alloc(24); png.set([137, 80, 78, 71, 13, 10, 26, 10]); png.set([73, 72, 68, 82], 12); png.writeUInt32BE(240, 16); png.writeUInt32BE(240, 20);
    await saveRenderArtifact(root, render, png);
    const pass = { status: "PASS" as const, evidence: ["Observed approved rule in the actual render."] };
    const categories = ["UX_NAVIGATION", "ACCESSIBILITY_REQUIRED_STATES", "PRODUCT_IDENTITY_SCREEN_FAMILY", "COMPONENTS_TOKENS", "HIERARCHY", "MOTION", "POLISH"] as const;
    await saveGovernanceCaptureSession(root, { id: render.sessionId, projectId: "project-a", type: "GOVERNANCE_CAPTURE", status: "COMPLETE", createdAt: at, updatedAt: at, state: "default", render, genomeEvidence: { entityId: approved.metadata.entityId, version: approved.value.version, revision: approved.metadata.revision, payloadHash: approved.payloadHash }, browserChecks: { navigation: "PASS", accessibility: "PASS", functionalVerification: "PASS", evidence: ["Real bounded browser smoke passed."] }, analysis: { threadId: "thread-proof", findings: [], verification: { uxIntegrity: pass, productConsistency: pass, accessibility: pass, genomeIntegrity: pass } }, verifiedCategories: categories.map((category) => ({ category, evidence: pass.evidence })) });
    const expectedRule = "Keep human decisions explicit.";
    const input: Parameters<typeof saveDriftReport>[0] = { rootPath: root, projectId: "project-a", expectedRevision: 1, evidenceCatalog: [{ id: "ev_proof_0001", kind: "RENDER", route: "/overview", excerpt: "Exact checked render", authenticatedRenderId: render.id, renderState: "default", renderCapturedAt: at, renderSourceRevisionFingerprint: "a".repeat(64), verifiedClaims: [{ claimType: "RULE", category: "UX_INVARIANT", statement: expectedRule, scope: { routes: ["/overview"] } }] }], report: { ...unavailableReport(), inspectedScope: ["/overview#default"], unavailableScope: [], unverifiedScope: [], overallStatus: "PASS", evidenceIds: ["ev_proof_0001"], verificationSessionIds: [render.sessionId] } };
    await saveDriftReport(input);
    expect((await readDriftReport(root, "project-a")).value.overallStatus).toBe("PASS");
    // Production break caught: an independently submitted Important finding can borrow otherwise clean capture labels and be signed as PASS_WITH_DEBT.
    const important = { category: "UX_NAVIGATION" as const, severity: "IMPORTANT" as const, scope: "/overview#default", evidenceIds: ["ev_proof_0001"], genomeRuleId: `genome-rule-${createHash("sha256").update(`UX_NAVIGATION\0${expectedRule}`).digest("hex").slice(0, 24)}`, expectedRule, observedEvidence: ["An explicit human decision is bypassed."], whyItMatters: "The approved workflow must retain its gate.", recommendedFix: "Restore the gate.", requiresDesignDecision: false, status: "OPEN" };
    await expect(saveDriftReport({ ...input, expectedRevision: 2, evidenceCatalog: [], report: { ...input.report, overallStatus: "PASS_WITH_DEBT", findings: [important] } })).rejects.toThrow(/cannot self-authenticate|blocking/i);
    expect((await readDriftReport(root, "project-a")).value.overallStatus).toBe("PASS");
  });

  it("publishes authenticated catalog/report state as a complete generation without inferring Registry PASS", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-")));
    roots.push(root);
    await initialize(root);

    await saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [{
        id: "ev_render_overview_01",
        kind: "RENDER",
        route: "/overview",
        excerpt: "Authenticated current render captured for this route.",
        authenticatedRenderId: "render-overview-01",
        renderState: "default",
        renderCapturedAt: "2026-08-31T12:00:00.000Z",
        renderSourceRevisionFingerprint: "a".repeat(64),
        verifiedClaims: [],
      }],
      report: {
        requestedScope: "SELECTED_SCREENS",
        expectedScope: [{ screen: "/overview", states: ["default"] }],
        inspectedScope: [],
        unavailableScope: ["/overview#default: Deterministic analysis is unavailable."],
        unverifiedScope: ["/overview#default: Deterministic analysis is unavailable."],
        evidenceIds: ["ev_render_overview_01"],
        findings: [],
        overallStatus: "NOT_VERIFIED",
      },
    });

    const report = await readDriftReport(root, "project-a");
    const registry = await readScreenRegistry(root, "project-a");
    expect(report.value.overallStatus).toBe("NOT_VERIFIED");
    expect(registry.records[0]).toMatchObject({
      driftStatus: "NOT_VERIFIED",
    });
    await expect(readFile(join(root, "design-governance", "DRIFT-REPORT.md"), "utf8"))
      .resolves.toContain("# Drift Report");
  });

  it("rejects caller-asserted PASS without authenticated state-bound render evidence", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-forged-")));
    roots.push(root);
    await initialize(root);

    await expect(saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [],
      report: {
        requestedScope: "SELECTED_SCREENS",
        expectedScope: [{ screen: "/overview", states: ["default"] }],
        inspectedScope: ["/overview#default"],
        unavailableScope: [],
        unverifiedScope: [],
        evidenceIds: ["ev_route_overview_01"],
        findings: [],
        overallStatus: "PASS",
      },
    })).rejects.toThrow(/authenticated.*render|cannot self-authenticate|deterministic/i);
  });

  it("never marks a Registry screen PASS when the audit contains no deterministic observations", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-empty-pass-")));
    roots.push(root);
    await initialize(root);

    await expect(saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [{
        id: "ev_render_overview_empty_pass_01",
        kind: "RENDER",
        route: "/overview",
        excerpt: "Authenticated render that has not received deterministic category analysis.",
        authenticatedRenderId: "render-overview-empty-pass-01",
        renderState: "default",
        renderCapturedAt: "2026-08-31T12:00:00.000Z",
        renderSourceRevisionFingerprint: "a".repeat(64),
        verifiedClaims: [],
      }],
      report: unavailableReport(),
      verifiedRegistry: [{
        screen: "/overview",
        states: ["default"],
        status: "PASS",
        evidenceIds: ["ev_render_overview_empty_pass_01"],
        lastVerified: "2026-08-31T12:00:00.000Z",
      }],
    })).rejects.toThrow(/Registry PASS|deterministic.*analysis/i);
  });

  it("rejects a finding with no observed evidence", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-empty-finding-")));
    roots.push(root);
    await initialize(root);
    const expectedRule = "Keep human decisions explicit.";
    const genomeRuleId = `genome-rule-${createHash("sha256")
      .update(`UX_NAVIGATION\0${expectedRule}`, "utf8")
      .digest("hex")
      .slice(0, 24)}`;

    await expect(saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [{
        id: "ev_render_overview_finding_01",
        kind: "RENDER",
        route: "/overview",
        excerpt: "Authenticated render evidence for the observed navigation drift.",
        authenticatedRenderId: "render-overview-finding-01",
        renderState: "default",
        renderCapturedAt: "2026-08-31T12:00:00.000Z",
        renderSourceRevisionFingerprint: "a".repeat(64),
        verifiedClaims: [{
          claimType: "RULE",
          category: "UX_INVARIANT",
          statement: expectedRule,
          scope: { routes: ["/overview"] },
        }],
      }],
      report: {
        ...unavailableReport(),
        evidenceIds: ["ev_render_overview_finding_01"],
        findings: [{
          category: "UX_NAVIGATION",
          severity: "IMPORTANT",
          scope: "/overview#default",
          evidenceIds: ["ev_render_overview_finding_01"],
          genomeRuleId,
          expectedRule,
          observedEvidence: [],
          whyItMatters: "Users cannot find the decision path.",
          recommendedFix: "Restore the approved action.",
          requiresDesignDecision: false,
          status: "OPEN",
        }],
      },
    })).rejects.toThrow(/observed evidence|finding/i);
  });

  it("rejects a finding whose catalog evidence is not a render for the finding's exact state and rule", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-cross-scope-finding-")));
    roots.push(root);
    await initialize(root);
    const expectedRule = "Keep human decisions explicit.";
    const genomeRuleId = `genome-rule-${createHash("sha256")
      .update(`UX_NAVIGATION\0${expectedRule}`, "utf8")
      .digest("hex")
      .slice(0, 24)}`;

    await expect(saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [{
        id: "ev_route_unbound_01",
        kind: "ROUTE",
        route: "/overview",
        excerpt: "Authenticated route inventory without state-bound render evidence.",
        verifiedClaims: [],
      }],
      report: {
        ...unavailableReport(),
        evidenceIds: ["ev_route_unbound_01"],
        findings: [{
          category: "UX_NAVIGATION",
          severity: "IMPORTANT",
          scope: "/overview#default",
          evidenceIds: ["ev_route_unbound_01"],
          genomeRuleId,
          expectedRule,
          observedEvidence: ["The primary action is missing from this captured state."],
          whyItMatters: "Users cannot find the decision path.",
          recommendedFix: "Restore the approved action.",
          requiresDesignDecision: false,
          status: "OPEN",
        }],
      },
    })).rejects.toThrow(/state|render|finding/i);
  });

  it("keeps the prior state when a generation faults after members are durable but before commit", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-recovery-")));
    roots.push(root);
    await initialize(root);
    setAuditTransactionFaultForTest("after-stage");
    await expect(saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [],
      report: {
        requestedScope: "SELECTED_SCREENS",
        expectedScope: [{ screen: "/overview", states: ["default"] }],
        inspectedScope: [],
        unavailableScope: ["/overview#default: No authenticated render."],
        unverifiedScope: ["/overview#default: No authenticated render."],
        evidenceIds: [],
        findings: [],
        overallStatus: "NOT_VERIFIED",
      },
    })).rejects.toThrow(/fault/i);
    setAuditTransactionFaultForTest(undefined);
    await expect(readDriftReport(root, "project-a")).rejects.toThrow(/ENOENT|missing|exist/i);
    await expect(readScreenRegistry(root, "project-a")).resolves.toMatchObject({
      metadata: { revision: 1 },
      records: [{ driftStatus: "NOT_VERIFIED" }],
    });
  });

  it("exposes the complete new generation after a fault immediately after durable activation", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-pointer-")));
    roots.push(root);
    await initialize(root);
    setAuditTransactionFaultForTest("after-pointer");
    await expect(saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [],
      report: unavailableReport(),
    })).rejects.toThrow(/fault/i);
    setAuditTransactionFaultForTest(undefined);
    const [report, registry] = await Promise.all([
      readDriftReport(root, "project-a"),
      readScreenRegistry(root, "project-a"),
    ]);
    expect(report.metadata.registryRevision).toBe(registry.metadata.revision);
    expect(report.metadata.registryEntityId).toBe(registry.metadata.entityId);
  });

  it("keeps generation A authoritative when generation B faults before its signed pointer is published", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-before-pointer-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({ rootPath: root, projectId: "project-a", expectedRevision: 1, evidenceCatalog: [], report: unavailableReport() });
    const registryA = await readScreenRegistry(root, "project-a");

    setAuditTransactionFaultForTest("before-pointer");
    await expect(saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: registryA.metadata.revision,
      evidenceCatalog: [],
      report: unavailableReport(),
    })).rejects.toThrow(/fault/i);
    setAuditTransactionFaultForTest(undefined);

    await expect(readScreenRegistry(root, "project-a")).resolves.toMatchObject({
      metadata: { entityId: registryA.metadata.entityId, revision: registryA.metadata.revision },
    });
  });

  it("keeps activated generation A readable when complete generation B crashes after commit fsync before pointer promotion", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-after-commit-before-pointer-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({ rootPath: root, projectId: "project-a", expectedRevision: 1, evidenceCatalog: [], report: unavailableReport() });
    const pointerPath = join(root, ".design-sharingan", "active-audit-generation.json");
    const generationAPointer = await readFile(pointerPath, "utf8");
    const registryA = await readScreenRegistry(root, "project-a");

    setAuditTransactionFaultForTest("after-commit-before-pointer");
    await expect(saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: registryA.metadata.revision,
      evidenceCatalog: [],
      report: unavailableReport(),
    })).rejects.toThrow(/fault/i);
    setAuditTransactionFaultForTest(undefined);

    expect(await readFile(pointerPath, "utf8")).toBe(generationAPointer);
    expect(await readdir(join(root, ".design-sharingan", "audit-generations"))).toHaveLength(2);
    await expect(readScreenRegistry(root, "project-a")).resolves.toMatchObject({
      metadata: { entityId: registryA.metadata.entityId, revision: registryA.metadata.revision },
    });

    await saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: registryA.metadata.revision,
      evidenceCatalog: [],
      report: unavailableReport(),
    });
    await expect(readScreenRegistry(root, "project-a")).resolves.toMatchObject({
      metadata: { revision: registryA.metadata.revision + 1 },
    });
    expect(await readdir(join(root, ".design-sharingan", "audit-generations"))).toHaveLength(2);
  });

  it("keeps activated generation A readable when B's pointer is durable but B has no activation", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-after-pointer-before-activation-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({ rootPath: root, projectId: "project-a", expectedRevision: 1, evidenceCatalog: [], report: unavailableReport() });
    const pointerPath = join(root, ".design-sharingan", "active-audit-generation.json");
    const generationAPointer = await readFile(pointerPath, "utf8");
    const registryA = await readScreenRegistry(root, "project-a");

    setAuditTransactionFaultForTest("after-pointer-before-activation");
    await expect(saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: registryA.metadata.revision,
      evidenceCatalog: [],
      report: unavailableReport(),
    })).rejects.toThrow(/fault/i);
    setAuditTransactionFaultForTest(undefined);

    expect(await readFile(pointerPath, "utf8")).not.toBe(generationAPointer);
    expect(await readdir(join(root, ".design-sharingan", "audit-generations"))).toHaveLength(2);
    await expect(readScreenRegistry(root, "project-a")).resolves.toMatchObject({
      metadata: { entityId: registryA.metadata.entityId, revision: registryA.metadata.revision },
    });
  });

  it("ignores an unsigned incomplete higher generation candidate during recovery", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-incomplete-candidate-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({ rootPath: root, projectId: "project-a", expectedRevision: 1, evidenceCatalog: [], report: unavailableReport() });
    const registry = await readScreenRegistry(root, "project-a");
    const candidate = join(root, ".design-sharingan", "audit-generations", "11111111-1111-4111-8111-111111111111");
    await mkdir(candidate, { mode: 0o700 });
    await writeFile(join(candidate, "commit.json"), "{not-authenticated}\n", "utf8");

    await expect(readScreenRegistry(root, "project-a")).resolves.toMatchObject({
      metadata: { entityId: registry.metadata.entityId, revision: registry.metadata.revision },
    });
  });

  it("rejects a seventeenth committed generation instead of overflowing bounded retention", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-retention-bound-")));
    roots.push(root);
    await initialize(root);
    let revision = 1;
    for (let index = 0; index < 16; index += 1) {
      await saveDriftReport({ rootPath: root, projectId: "project-a", expectedRevision: revision, evidenceCatalog: [], report: unavailableReport() });
      revision = (await readScreenRegistry(root, "project-a")).metadata.revision;
    }

    await expect(saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: revision,
      evidenceCatalog: [],
      report: unavailableReport(),
    })).rejects.toThrow(/retention|bounded/i);
  }, 15_000);

  it("rejects an audit sequence increment past the safe integer maximum", () => {
    expect(() => incrementAuditGenerationSequence(Number.MAX_SAFE_INTEGER)).toThrow(/safe maximum/i);
  });

  it("rejects replay of generation A's signed pointer after generation B committed before an after-pointer crash", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-after-pointer-replay-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [],
      report: unavailableReport(),
    });
    const pointerPath = join(root, ".design-sharingan", "active-audit-generation.json");
    const generationAPointer = await readFile(pointerPath, "utf8");
    const registry = await readScreenRegistry(root, "project-a");

    setAuditTransactionFaultForTest("after-pointer");
    await expect(saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: registry.metadata.revision,
      evidenceCatalog: [{
        id: "ev_route_after_pointer_b_01",
        kind: "ROUTE",
        route: "/reports",
        excerpt: "Authenticated evidence committed by generation B.",
        verifiedClaims: [],
      }],
      report: unavailableReport(),
    })).rejects.toThrow(/fault/i);
    setAuditTransactionFaultForTest(undefined);

    await writeFile(pointerPath, generationAPointer, "utf8");
    await expect(readScreenRegistry(root, "project-a")).rejects.toThrow(/head|generation|replay|behind/i);
  });

  it("rejects a pointer whose Registry file no longer has the committed generation revision", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-revision-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [],
      report: unavailableReport(),
    });
    const pointer = JSON.parse(await readFile(join(root, ".design-sharingan", "active-audit-generation.json"), "utf8")) as {
      generationId: string;
    };
    const registryPath = join(root, ".design-sharingan", "audit-generations", pointer.generationId, "SCREEN-REGISTRY.md");
    const registry = parseGovernanceMetadata(await readFile(registryPath, "utf8"));
    if (registry.kind !== "SCREEN_REGISTRY") throw new Error("test fixture must contain a Screen Registry");
    await writeFile(registryPath, renderScreenRegistry({ ...registry, revision: registry.revision + 1 }), "utf8");

    await expect(readScreenRegistry(root, "project-a")).rejects.toThrow(/generation|pointer|inconsistent/i);
  });

  it("rejects canonical Registry body tampering that preserves the committed entity and revision", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-registry-digest-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [],
      report: unavailableReport(),
    });
    const pointer = JSON.parse(await readFile(join(root, ".design-sharingan", "active-audit-generation.json"), "utf8")) as {
      generationId: string;
    };
    const registryPath = join(root, ".design-sharingan", "audit-generations", pointer.generationId, "SCREEN-REGISTRY.md");
    const registry = parseGovernanceMetadata(await readFile(registryPath, "utf8"));
    if (registry.kind !== "SCREEN_REGISTRY") throw new Error("test fixture must contain a Screen Registry");
    await writeFile(registryPath, renderScreenRegistry({
      ...registry,
      records: registry.records.map((record) => ({ ...record, name: "Tampered Overview" })),
    }), "utf8");

    await expect(readScreenRegistry(root, "project-a")).rejects.toThrow(/digest|generation|integrity/i);
  });

  it("rejects Drift Report body tampering that preserves its committed identity and revision", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-report-digest-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [],
      report: unavailableReport(),
    });
    const pointer = JSON.parse(await readFile(join(root, ".design-sharingan", "active-audit-generation.json"), "utf8")) as {
      generationId: string;
    };
    const reportPath = join(root, ".design-sharingan", "audit-generations", pointer.generationId, "DRIFT-REPORT.md");
    const report = parseGovernanceMetadata(await readFile(reportPath, "utf8"));
    if (report.kind !== "DRIFT_REPORT") throw new Error("test fixture must contain a Drift Report");
    await writeFile(reportPath, renderDriftReport({
      ...report,
      value: {
        ...report.value,
        unverifiedScope: ["/overview#default: Tampered report body."],
      },
    }), "utf8");

    await expect(readDriftReport(root, "project-a")).rejects.toThrow(/digest|generation|integrity/i);
  });

  it("rejects a manifest byte mutation even when its parsed signed relations are unchanged", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-manifest-canonical-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [],
      report: unavailableReport(),
    });
    const pointer = JSON.parse(await readFile(join(root, ".design-sharingan", "active-audit-generation.json"), "utf8")) as {
      generationId: string;
    };
    const manifestPath = join(
      root,
      ".design-sharingan",
      "audit-generations",
      pointer.generationId,
      "manifest.json",
    );
    await writeFile(manifestPath, `\n${await readFile(manifestPath, "utf8")}`, "utf8");

    await expect(readDriftReport(root, "project-a")).rejects.toThrow(/manifest|generation|integrity/i);
  });

  it("fails closed when the signed durable commit record is tampered", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-commit-tamper-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({ rootPath: root, projectId: "project-a", expectedRevision: 1, evidenceCatalog: [], report: unavailableReport() });
    const pointer = JSON.parse(await readFile(join(root, ".design-sharingan", "active-audit-generation.json"), "utf8")) as { generationId: string };
    const commitPath = join(root, ".design-sharingan", "audit-generations", pointer.generationId, "commit.json");
    await writeFile(commitPath, `\n${await readFile(commitPath, "utf8")}`, "utf8");

    await expect(readScreenRegistry(root, "project-a")).rejects.toThrow(/commit|generation|head/i);
  });

  it("fails closed when the signed active pointer is byte-tampered", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-pointer-tamper-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({ rootPath: root, projectId: "project-a", expectedRevision: 1, evidenceCatalog: [], report: unavailableReport() });
    const pointerPath = join(root, ".design-sharingan", "active-audit-generation.json");
    await writeFile(pointerPath, `\n${await readFile(pointerPath, "utf8")}`, "utf8");

    await expect(readScreenRegistry(root, "project-a")).rejects.toThrow(/pointer|generation|head/i);
  });

  it("fails closed when a signed committed generation has a tampered activation record", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-activation-tamper-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({ rootPath: root, projectId: "project-a", expectedRevision: 1, evidenceCatalog: [], report: unavailableReport() });
    const pointer = JSON.parse(await readFile(join(root, ".design-sharingan", "active-audit-generation.json"), "utf8")) as { generationId: string };
    const activationPath = join(root, ".design-sharingan", "audit-generations", pointer.generationId, "activation.json");
    await writeFile(activationPath, `\n${await readFile(activationPath, "utf8")}`, "utf8");

    await expect(readScreenRegistry(root, "project-a")).rejects.toThrow(/activation|generation|head/i);
  });

  it("rejects a signed catalog substituted from an earlier generation", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-catalog-digest-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({ rootPath: root, projectId: "project-a", expectedRevision: 1, evidenceCatalog: [], report: unavailableReport() });
    const firstPointer = JSON.parse(await readFile(join(root, ".design-sharingan", "active-audit-generation.json"), "utf8")) as { generationId: string };
    const firstCatalog = await readFile(join(root, ".design-sharingan", "audit-generations", firstPointer.generationId, "governance-evidence.json"), "utf8");
    const registry = await readScreenRegistry(root, "project-a");
    await saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: registry.metadata.revision,
      evidenceCatalog: [{
        id: "ev_route_reports_01",
        kind: "ROUTE",
        route: "/reports",
        excerpt: "Authenticated additional route inventory.",
        verifiedClaims: [],
      }],
      report: unavailableReport(),
    });
    const currentPointer = JSON.parse(await readFile(join(root, ".design-sharingan", "active-audit-generation.json"), "utf8")) as { generationId: string };
    await writeFile(join(root, ".design-sharingan", "audit-generations", currentPointer.generationId, "governance-evidence.json"), firstCatalog, "utf8");

    await expect(readEvidenceCatalog(root, "project-a")).rejects.toThrow(/digest|generation|integrity/i);
  });

  it("rejects a signed manifest substituted from an earlier generation", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-manifest-substitution-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({ rootPath: root, projectId: "project-a", expectedRevision: 1, evidenceCatalog: [], report: unavailableReport() });
    const pointerPath = join(root, ".design-sharingan", "active-audit-generation.json");
    const firstPointer = JSON.parse(await readFile(pointerPath, "utf8")) as { generationId: string };
    const firstManifest = await readFile(join(root, ".design-sharingan", "audit-generations", firstPointer.generationId, "manifest.json"), "utf8");
    const registry = await readScreenRegistry(root, "project-a");
    await saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: registry.metadata.revision,
      evidenceCatalog: [{
        id: "ev_route_reports_manifest_01",
        kind: "ROUTE",
        route: "/reports",
        excerpt: "Authenticated route inventory for the next generation.",
        verifiedClaims: [],
      }],
      report: unavailableReport(),
    });
    const currentPointer = JSON.parse(await readFile(pointerPath, "utf8")) as { generationId: string };
    await writeFile(
      join(root, ".design-sharingan", "audit-generations", currentPointer.generationId, "manifest.json"),
      firstManifest,
      "utf8",
    );

    await expect(readDriftReport(root, "project-a")).rejects.toThrow(/manifest|generation|integrity/i);
  });

  it("rejects replay of an older signed pointer after a newer generation is committed", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-pointer-replay-")));
    roots.push(root);
    await initialize(root);
    await saveDriftReport({ rootPath: root, projectId: "project-a", expectedRevision: 1, evidenceCatalog: [], report: unavailableReport() });
    const pointerPath = join(root, ".design-sharingan", "active-audit-generation.json");
    const firstPointer = await readFile(pointerPath, "utf8");
    const registry = await readScreenRegistry(root, "project-a");
    await saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: registry.metadata.revision,
      evidenceCatalog: [{
        id: "ev_route_reports_02",
        kind: "ROUTE",
        route: "/reports",
        excerpt: "Authenticated later route inventory.",
        verifiedClaims: [],
      }],
      report: unavailableReport(),
    });
    await writeFile(pointerPath, firstPointer, "utf8");

    await expect(readScreenRegistry(root, "project-a")).rejects.toThrow(/generation|pointer|integrity/i);
  });

  it("rejects concurrent writers and stale Registry generations instead of mixing audit truth", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-concurrent-")));
    roots.push(root);
    await initialize(root);
    const input = {
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [],
      report: unavailableReport(),
    };
    const results = await Promise.allSettled([saveDriftReport(input), saveDriftReport(input)]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);

    const registry = await readScreenRegistry(root, "project-a");
    await saveScreenRegistry(root, "project-a", registry.records, registry.metadata.revision);
    await expect(readDriftReport(root, "project-a")).rejects.toThrow(/Registry|related|revision/i);
  });

  it("retains an unresolved prior drift finding until an authenticated resolution supersedes it", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-retention-")));
    roots.push(root);
    await initialize(root);
    const expectedRule = "Keep human decisions explicit.";
    const genomeRuleId = `genome-rule-${createHash("sha256")
      .update(`UX_NAVIGATION\0${expectedRule}`, "utf8")
      .digest("hex")
      .slice(0, 24)}`;
    await saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: 1,
      evidenceCatalog: [{
        id: "ev_render_overview_retention_01",
        kind: "RENDER",
        route: "/overview",
        excerpt: "Authenticated render evidence for the unresolved navigation drift.",
        authenticatedRenderId: "render-overview-retention-01",
        renderState: "default",
        renderCapturedAt: "2026-08-31T12:00:00.000Z",
        renderSourceRevisionFingerprint: "a".repeat(64),
        verifiedClaims: [{
          claimType: "RULE",
          category: "UX_INVARIANT",
          statement: expectedRule,
          scope: { routes: ["/overview"] },
        }],
      }],
      report: {
        ...unavailableReport(),
        evidenceIds: ["ev_render_overview_retention_01"],
        findings: [{
          category: "UX_NAVIGATION",
          severity: "IMPORTANT",
          scope: "/overview#default",
          evidenceIds: ["ev_render_overview_retention_01"],
          genomeRuleId,
          expectedRule,
          observedEvidence: ["The visible primary action is absent."],
          whyItMatters: "Users cannot find the explicit decision path.",
          recommendedFix: "Restore the existing primary action.",
          requiresDesignDecision: false,
          status: "OPEN",
        }],
      },
    });
    const registry = await readScreenRegistry(root, "project-a");
    await saveDriftReport({
      rootPath: root,
      projectId: "project-a",
      expectedRevision: registry.metadata.revision,
      evidenceCatalog: [],
      report: unavailableReport(),
    });
    await expect(readDriftReport(root, "project-a")).resolves.toMatchObject({
      value: { findings: [{ genomeRuleId, status: "OPEN" }] },
    });
  });
});
