import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignGenome, ScreenRecord } from "@design-sharingan/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeGovernance,
  readDriftReport,
  readScreenRegistry,
  saveDriftReport,
  saveScreenRegistry,
  setAuditTransactionFaultForTest,
} from "../index";
import { parseGovernanceMetadata, renderScreenRegistry } from "../templates";

const roots: string[] = [];

function genome(): DesignGenome {
  return {
    version: "0.1.0",
    status: "DRAFT",
    productIdentity: "A calm local-first design intelligence environment.",
    uxInvariants: ["Keep human decisions explicit."],
    visualInvariants: [],
    motionRules: [],
    accessibilityRules: ["Maintain visible focus."],
    componentDNA: [],
    screenFamilies: ["Project workspaces"],
    contentVoice: [],
    intentionalExceptions: [],
    unconfirmedRules: [],
  };
}

function screen(): ScreenRecord {
  return {
    id: "screen-overview",
    route: "/overview",
    name: "Overview",
    family: "Project workspaces",
    inheritedRules: ["Keep human decisions explicit."],
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

async function initialize(rootPath: string): Promise<void> {
  await initializeGovernance({
    rootPath,
    projectId: "project-a",
    genome: genome(),
    screens: [screen()],
    decisions: [],
    evidenceCatalog: [{
      id: "ev_route_overview_01",
      kind: "ROUTE",
      route: "/overview",
      excerpt: "Authenticated route inventory.",
      verifiedClaims: [],
    }],
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Drift Report governance store", () => {
  it("publishes authenticated catalog/report state as a complete generation without inferring Registry PASS", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-")));
    roots.push(root);
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: genome(),
      screens: [screen()],
      decisions: [],
      evidenceCatalog: [{
        id: "ev_route_overview_01",
        kind: "ROUTE",
        route: "/overview",
        excerpt: "Authenticated route inventory.",
        verifiedClaims: [],
      }],
    });

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
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: genome(),
      screens: [screen()],
      decisions: [],
      evidenceCatalog: [{
        id: "ev_route_overview_01",
        kind: "ROUTE",
        route: "/overview",
        excerpt: "Authenticated route inventory.",
        verifiedClaims: [],
      }],
    });

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

  it("recovers an incomplete audit generation without exposing a partial Registry/report pair", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "drift-report-recovery-")));
    roots.push(root);
    await initializeGovernance({
      rootPath: root,
      projectId: "project-a",
      genome: genome(),
      screens: [screen()],
      decisions: [],
      evidenceCatalog: [{
        id: "ev_route_overview_01",
        kind: "ROUTE",
        route: "/overview",
        excerpt: "Authenticated route inventory.",
        verifiedClaims: [],
      }],
    });
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

  it("exposes the complete new generation after a fault immediately after the authoritative pointer", async () => {
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
      evidenceCatalog: [],
      report: {
        ...unavailableReport(),
        evidenceIds: ["ev_route_overview_01"],
        findings: [{
          category: "UX_NAVIGATION",
          severity: "IMPORTANT",
          scope: "/overview#default",
          evidenceIds: ["ev_route_overview_01"],
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
