import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignGenome, ScreenRecord } from "@design-sharingan/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeGovernance,
  readDriftReport,
  readScreenRegistry,
  saveDriftReport,
} from "../index";

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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Drift Report governance store", () => {
  it("publishes an authenticated verification catalog entry before the verified Registry/report state", async () => {
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
        renderCapturedAt: "2026-08-31T12:00:00.000Z",
        renderSourceRevisionFingerprint: "a".repeat(64),
        verifiedClaims: [],
      }],
      report: {
        requestedScope: "SELECTED_SCREENS",
        expectedScope: [{ screen: "/overview", states: ["default"] }],
        inspectedScope: ["/overview#default"],
        unavailableScope: [],
        unverifiedScope: [],
        evidenceIds: ["ev_render_overview_01"],
        findings: [],
        overallStatus: "PASS",
      },
      verifiedRegistry: [{
        screen: "/overview",
        states: ["default"],
        status: "PASS",
        evidenceIds: ["ev_render_overview_01"],
        lastVerified: "2026-08-31T12:00:00.000Z",
      }],
    });

    const report = await readDriftReport(root, "project-a");
    const registry = await readScreenRegistry(root, "project-a");
    expect(report.value.overallStatus).toBe("PASS");
    expect(registry.records[0]).toMatchObject({
      driftStatus: "PASS",
      lastVerified: "2026-08-31T12:00:00.000Z",
    });
    expect(registry.records[0]?.evidence).toContain("ev_render_overview_01");
    await expect(readFile(join(root, "design-governance", "DRIFT-REPORT.md"), "utf8"))
      .resolves.toContain("# Drift Report");
  });
});
