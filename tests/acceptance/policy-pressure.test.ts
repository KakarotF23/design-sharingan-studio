import type {
  DesignGenome,
  FeatureBrief,
} from "../../packages/core/src/domain";
import {
  DEFAULT_AUTONOMY_POLICY,
  evaluateAutonomyPolicy,
} from "../../packages/core/src/policy";
import { runDriftAudit } from "../../packages/eternal-engine/src/audit";
import { guardFeature } from "../../packages/eternal-engine/src/guard";
import { evaluateStopCriteria } from "../../packages/mangekyo-engine/src/stop-criteria";
import { describe, expect, it } from "vitest";

const verifiedIntegrity = {
  uxIntegrity: "PASS",
  productConsistency: "PASS",
  accessibility: "PASS",
  genomeIntegrity: "PASS",
} as const;

const featureBrief: FeatureBrief = {
  name: "Evidence queue",
  goal: "Make unresolved evidence easy to triage.",
  description: "Add a bounded queue inside the existing workspace.",
  constraints: ["Keep the current information architecture."],
  mustKeep: ["Human decisions remain explicit."],
  mustNotChange: ["Do not add navigation destinations."],
  successCriteria: ["A reviewer can identify the next decision."],
};

function approvedGenome(): DesignGenome {
  return {
    version: "0.1.0",
    status: "APPROVED",
    productIdentity: "A calm local-first design intelligence environment.",
    uxInvariants: ["Keep human decisions explicit."],
    visualInvariants: ["Use restrained contrast."],
    motionRules: ["Reserve motion for state transitions."],
    accessibilityRules: ["Maintain visible focus."],
    componentDNA: ["Use fine rules to separate evidence."],
    screenFamilies: ["Project workspaces"],
    contentVoice: ["Calm, technical, and direct."],
    intentionalExceptions: [],
    unconfirmedRules: [],
  };
}

describe("v0.1 policy pressure acceptance", () => {
  it.each([
    ["dependency installation", "DEPENDENCY_INSTALL", ["package.json"]],
    ["navigation mutation", "NAVIGATION_CHANGE", ["src/navigation.ts"]],
    ["file deletion", "FILE_DELETION", ["src/legacy.css"]],
  ] as const)("requires a human gate for autonomous %s", (_label, kind, files) => {
    expect(evaluateAutonomyPolicy(DEFAULT_AUTONOMY_POLICY, { kind, files })).toEqual({
      decision: "HUMAN_GATE",
      reasons: [`${kind} exceeds the approved autonomy policy.`],
    });
  });

  it("cannot report a whole-app PASS from one inspected screen", async () => {
    const report = await runDriftAudit({
      requestedScope: "WHOLE_APP",
      expectedScope: [
        { screen: "/overview", states: ["default"] },
        { screen: "/reports", states: ["default"] },
      ],
      evidence: [{
        screen: "/overview",
        state: "default",
        status: "INSPECTED",
        evidenceIds: ["ev_render_overview_01"],
      }],
    });

    expect(report.overallStatus).toBe("NOT_VERIFIED");
    expect(report.unverifiedScope).toEqual(expect.arrayContaining([
      "Whole-product inspected screens do not exactly match the explicit expected screen set.",
      "/reports#default: Evidence is not inspected.",
    ]));
  });

  it("cannot report visual PASS without a fresh render after the final change", () => {
    expect(evaluateStopCriteria({
      round: 2,
      maxRounds: 5,
      criticalCount: 0,
      importantCount: 0,
      importantThreshold: 2,
      uxRegressions: 0,
      genomeConflicts: 0,
      integrity: verifiedIntegrity,
      hasFreshFinalRender: false,
      claimedScreens: ["/overview"],
      inspectedScreens: ["/overview"],
    })).toEqual({
      stop: false,
      pass: false,
      outcome: "CONTINUE",
      reason: "A fresh render is required after the final change.",
    });
  });

  it("keeps repeated drift as a human decision without rewriting the Genome", async () => {
    const genome = approvedGenome();
    const before = structuredClone(genome);
    const candidate = "Use glowing borders on evidence panels.";
    const result = await guardFeature({
      genome,
      featureBrief,
      repeatedPatterns: [{
        rule: candidate,
        screens: ["/overview", "/learn", "/reports"],
        classification: "DRIFT",
      }],
    });

    expect(genome).toEqual(before);
    expect(result.DECIDE).toContain(candidate);
    expect(result.INHERIT).not.toContain(candidate);
  });
});
