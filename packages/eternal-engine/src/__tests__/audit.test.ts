import type { DesignGenome } from "@design-sharingan/core";
import { describe, expect, it } from "vitest";
import { AUDIT_ORDER, runDriftAudit } from "../audit";

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

describe("Drift audit", () => {
  it("cannot call a one-screen audit a whole-app audit", async () => {
    const report = await runDriftAudit({
      requestedScope: "WHOLE_APP",
      evidence: [{ screen: "Home", status: "INSPECTED" }],
    });

    expect(report.overallStatus).toBe("NOT_VERIFIED");
    expect(report.unverifiedScope.length).toBeGreaterThan(0);
  });

  it("marks an enumerated required state unavailable instead of treating the screen as complete", async () => {
    const report = await runDriftAudit({
      requestedScope: "WHOLE_APP",
      expectedScope: [{ screen: "/overview", states: ["default", "loading", "error"] }],
      evidence: [
        { screen: "/overview", state: "default", status: "INSPECTED", evidenceIds: ["ev_render_overview_01"] },
        { screen: "/overview", state: "loading", status: "UNAVAILABLE", reason: "No authenticated loading render." },
        { screen: "/overview", state: "error", status: "UNAVAILABLE", reason: "No authenticated error render." },
      ],
    });

    expect(report.overallStatus).toBe("NOT_VERIFIED");
    expect(report.inspectedScope).toEqual(["/overview#default"]);
    expect(report.unavailableScope).toEqual([
      "/overview#loading: No authenticated loading render.",
      "/overview#error: No authenticated error render.",
    ]);
  });

  it("orders findings by the approved audit sequence instead of input order", async () => {
    const report = await runDriftAudit({
      requestedScope: "SELECTED_SCREENS",
      expectedScope: [{ screen: "/overview", states: ["default"] }],
      evidence: [{
        screen: "/overview",
        state: "default",
        status: "INSPECTED",
        evidenceIds: ["ev_render_overview_02"],
        observations: [
          {
            category: "POLISH",
            severity: "POLISH",
            expectedRule: "Keep spacing rhythm consistent.",
            observedEvidence: ["The lower divider is offset by 4px."],
            whyItMatters: "Small rhythm differences accumulate in dense evidence views.",
            recommendedFix: "Align the divider to the shared inset token.",
          },
          {
            category: "UX_NAVIGATION",
            severity: "IMPORTANT",
            expectedRule: "Keep primary decisions explicit.",
            observedEvidence: ["The review action is not discoverable from the route header."],
            whyItMatters: "Users cannot complete the primary audit task reliably.",
            recommendedFix: "Restore the visible review action in the existing header.",
          },
          {
            category: "MOTION",
            severity: "POLISH",
            expectedRule: "Reserve motion for state transitions.",
            observedEvidence: ["A decorative panel loops continuously."],
            whyItMatters: "Continuous motion distracts from evidence review.",
            recommendedFix: "Remove the ambient loop.",
          },
        ],
      }],
    });

    expect(AUDIT_ORDER).toEqual([
      "UX_NAVIGATION",
      "ACCESSIBILITY_REQUIRED_STATES",
      "PRODUCT_IDENTITY_SCREEN_FAMILY",
      "COMPONENTS_TOKENS",
      "HIERARCHY",
      "MOTION",
      "POLISH",
    ]);
    expect(report.findings.map(({ category }) => category)).toEqual([
      "UX_NAVIGATION",
      "MOTION",
      "POLISH",
    ]);
  });

  it("keeps repeated drift as a decision candidate without mutating the approved Genome", async () => {
    const genome = approvedGenome();
    const before = structuredClone(genome);

    const report = await runDriftAudit({
      requestedScope: "SELECTED_SCREENS",
      approvedGenome: genome,
      expectedScope: [{ screen: "/overview", states: ["default"] }],
      evidence: [{
        screen: "/overview",
        state: "default",
        status: "INSPECTED",
        evidenceIds: ["ev_render_overview_03"],
        observations: [{
          category: "COMPONENTS_TOKENS",
          severity: "IMPORTANT",
          expectedRule: "Use restrained contrast.",
          observedEvidence: ["Three screens use an unapproved glow border."],
          whyItMatters: "Repeated drift does not establish a product rule.",
          recommendedFix: "Remove the glow or record an approved Design Decision.",
          repeatedAcrossScreens: ["/overview", "/learn", "/reports"],
        }],
      }],
    });

    expect(genome).toEqual(before);
    expect(report.findings[0]).toMatchObject({
      requiresDesignDecision: true,
      status: "DECIDE",
    });
    expect(genome.visualInvariants).not.toContain("Three screens use an unapproved glow border.");
  });
});
