import type { DesignGenome, VisualFinding } from "@design-sharingan/core";
import { describe, expect, it } from "vitest";
import {
  AUDIT_ORDER,
  driftObservationFromAuthenticatedVisualFinding,
  runDriftAudit,
  observationsForApprovedGenome,
  auditResultStatus,
} from "../audit";

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

function completeIntentionalObservations() {
  return [
    ["UX_NAVIGATION", "Keep human decisions explicit."],
    ["ACCESSIBILITY_REQUIRED_STATES", "Maintain visible focus."],
    ["PRODUCT_IDENTITY_SCREEN_FAMILY", "A calm local-first design intelligence environment."],
    ["COMPONENTS_TOKENS", "Use restrained contrast."],
    ["HIERARCHY", "Use restrained contrast."],
    ["MOTION", "Reserve motion for state transitions."],
    ["POLISH", "Use restrained contrast."],
  ].map(([category, expectedRule]) => ({
    category: category as (typeof AUDIT_ORDER)[number],
    severity: "INTENTIONAL" as const,
    expectedRule,
    observedEvidence: ["The deterministic comparator inspected the authenticated render."],
    whyItMatters: "The approved rule remains explicitly verified.",
    recommendedFix: "No change is required.",
  }));
}

describe("Drift audit", () => {
  // Production break caught: a fully observed Important finding is mislabeled PASS_WITH_DEBT, although only polish may use that path.
  it("keeps Important drift unresolved and reserves debt status for polish", () => {
    expect(auditResultStatus({ unverifiedScope: [], findings: [{ severity: "IMPORTANT" }] })).toBe("NOT_VERIFIED");
    expect(auditResultStatus({ unverifiedScope: [], findings: [{ severity: "POLISH" }] })).toBe("PASS_WITH_DEBT");
  });
  // Production break caught: governed capture substitutes the first category rule or drops an unmatched Critical finding instead of preserving uncertainty.
  it("binds exact approved rule observations and retains unmatched critical evidence as a human decision", () => {
    const genome = { ...approvedGenome(), visualInvariants: ["Use restrained contrast.", "Preserve the primary heading."] };
    const finding: VisualFinding = { id: "finding-second-rule", screen: "/", category: "HIERARCHY", severity: "IMPORTANT", description: "Heading priority changed", evidence: ["Approved rule: Preserve the primary heading."], reason: "Primary task is unclear", recommendedAction: "Restore the heading", status: "OPEN" };
    expect(observationsForApprovedGenome([finding], genome)[0]?.expectedRule).toBe("Preserve the primary heading.");
    const unmatched = observationsForApprovedGenome([{ ...finding, severity: "CRITICAL", category: "MOTION", evidence: ["Rapid flashing harms readability"] }], { ...genome, motionRules: [] });
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toMatchObject({ severity: "CRITICAL", requiresDesignDecision: true });
  });
  // Production break: verified clean categories must invent INTENTIONAL findings because absence of drift is always treated as missing analysis.
  it("records explicit clean category checks without inventing drift findings", async () => {
    const report = await runDriftAudit({ requestedScope: "SELECTED_SCREENS", expectedScope: [{ screen: "/", states: ["default"] }], evidence: [{ screen: "/", state: "default", status: "INSPECTED", evidenceIds: ["ev_clean"], verifiedCategories: AUDIT_ORDER.map((category) => ({ category, evidence: ["Authenticated rendered rule inspection found no deviation."] })) }] });
    expect(report.findings).toEqual([]);
    expect(report.unverifiedScope.some((reason) => reason.includes("Deterministic analysis"))).toBe(false);
    expect(report.overallStatus).toBe("NOT_VERIFIED"); // Raw clean checks still cannot replace approved Genome authority.
  });
  // Production break: non-hierarchy findings and Critical/Polish severities disappear at the audit boundary.
  it("preserves supported visual categories and severity instead of only the fixture hierarchy Important case", () => {
    const observation = driftObservationFromAuthenticatedVisualFinding({ category: "ACCESSIBILITY", severity: "CRITICAL", evidence: ["Primary control is unreadable"], reason: "Primary task inaccessible", recommendedAction: "Restore contrast", status: "OPEN" }, "Maintain visible focus.");
    expect(observation).toMatchObject({ category: "ACCESSIBILITY_REQUIRED_STATES", severity: "CRITICAL" });
  });
  it("maps an authenticated important hierarchy result into a catalog-bound audit observation", () => {
    const finding: Pick<VisualFinding, "category" | "severity" | "evidence" | "reason" | "recommendedAction" | "status"> = {
      category: "HIERARCHY",
      severity: "IMPORTANT",
      evidence: ["The rendered heading and support copy retain similar visual weight."],
      reason: "The first scan does not establish a decisive entry point.",
      recommendedAction: "Refine one hierarchy objective while preserving navigation.",
      status: "OPEN",
    };

    expect(driftObservationFromAuthenticatedVisualFinding(
      finding,
      "Preserve the established product hierarchy and component language.",
    )).toEqual({
      category: "HIERARCHY",
      severity: "IMPORTANT",
      expectedRule: "Preserve the established product hierarchy and component language.",
      observedEvidence: finding.evidence,
      whyItMatters: finding.reason,
      recommendedFix: finding.recommendedAction,
      status: "OPEN",
    });
    expect(driftObservationFromAuthenticatedVisualFinding({
      ...finding,
      category: "SPACING",
    }, "Preserve the established product hierarchy and component language.")).toMatchObject({ category: "COMPONENTS_TOKENS", severity: "IMPORTANT" });
  });

  it("cannot call a one-screen audit a whole-app audit", async () => {
    const report = await runDriftAudit({
      requestedScope: "WHOLE_APP",
      evidence: [{ screen: "Home", status: "INSPECTED" }],
    });

    expect(report.overallStatus).toBe("NOT_VERIFIED");
    expect(report.unverifiedScope.length).toBeGreaterThan(0);
  });

  it("requires distinct canonical expected and inspected screens for a whole-app audit", async () => {
    const report = await runDriftAudit({
      requestedScope: "WHOLE_APP",
      expectedScope: [{ screen: "/overview", states: ["default", "loading"] }],
      evidence: [
        { screen: "/overview", state: "default", status: "INSPECTED", evidenceIds: ["ev_render_scope_01"] },
        { screen: "/overview", state: "loading", status: "INSPECTED", evidenceIds: ["ev_render_scope_02"] },
      ],
    });

    expect(report.overallStatus).toBe("NOT_VERIFIED");
    expect(report.unverifiedScope).toContain("Whole-product scope requires more than one distinct canonical screen.");
  });

  it("does not treat an inspected row without an authenticated evidence identity or analysis as a pass", async () => {
    const report = await runDriftAudit({
      requestedScope: "SELECTED_SCREENS",
      expectedScope: [{ screen: "/overview", states: ["default"] }],
      evidence: [{ screen: "/overview", state: "default", status: "INSPECTED" }],
    });

    expect(report.overallStatus).toBe("NOT_VERIFIED");
    expect(report.unverifiedScope).toEqual(expect.arrayContaining([
      "/overview#default: Authenticated rendered evidence is missing.",
      "UX_NAVIGATION: Deterministic analysis is unavailable for /overview#default.",
    ]));
  });

  it("does not accept an untrusted raw Genome value as authoritative audit input", async () => {
    const report = await runDriftAudit({
      requestedScope: "SELECTED_SCREENS",
      approvedGenome: approvedGenome() as unknown as import("@design-sharingan/governance").GenomeDocument,
      expectedScope: [{ screen: "/overview", states: ["default"] }],
      evidence: [{
        screen: "/overview",
        state: "default",
        status: "INSPECTED",
        evidenceIds: ["ev_render_overview_04"],
        observations: completeIntentionalObservations(),
      }],
    });

    expect(report.overallStatus).toBe("NOT_VERIFIED");
    expect(report.unverifiedScope).toEqual(expect.arrayContaining([
      expect.stringMatching(/authoritative.*Genome/i),
    ]));
  });

  it("marks an extra inspected canonical state outside the expected state set as unverified", async () => {
    const report = await runDriftAudit({
      requestedScope: "SELECTED_SCREENS",
      approvedGenome: approvedGenome() as unknown as import("@design-sharingan/governance").GenomeDocument,
      expectedScope: [{ screen: "/overview", states: ["default"] }],
      evidence: [
        {
          screen: "/overview",
          state: "default",
          status: "INSPECTED",
          evidenceIds: ["ev_render_overview_05"],
          observations: completeIntentionalObservations(),
        },
        {
          screen: "/overview",
          state: "loading",
          status: "INSPECTED",
          evidenceIds: ["ev_render_overview_loading_05"],
        },
      ],
    });

    expect(report.overallStatus).toBe("NOT_VERIFIED");
    expect(report.unverifiedScope).toEqual(expect.arrayContaining([
      "/overview#loading: Evidence is outside the explicit expected state scope.",
    ]));
  });

  it("marks an out-of-scope extra state unavailable rather than silently ignoring it", async () => {
    const report = await runDriftAudit({
      requestedScope: "SELECTED_SCREENS",
      approvedGenome: approvedGenome() as unknown as import("@design-sharingan/governance").GenomeDocument,
      expectedScope: [{ screen: "/overview", states: ["default"] }],
      evidence: [
        {
          screen: "/overview",
          state: "default",
          status: "INSPECTED",
          evidenceIds: ["ev_render_overview_05"],
          observations: completeIntentionalObservations(),
        },
        {
          screen: "/overview",
          state: "loading",
          status: "OUT_OF_SCOPE",
          reason: "The loading state is not in the registered audit scope.",
        },
      ],
    });

    expect(report.overallStatus).toBe("NOT_VERIFIED");
    expect(report.unverifiedScope).toEqual(expect.arrayContaining([
      "/overview#loading: Evidence is outside the explicit expected state scope.",
    ]));
  });

  it("rejects a drift observation without bounded observed evidence", async () => {
    await expect(runDriftAudit({
      requestedScope: "SELECTED_SCREENS",
      approvedGenome: approvedGenome() as unknown as import("@design-sharingan/governance").GenomeDocument,
      expectedScope: [{ screen: "/overview", states: ["default"] }],
      evidence: [{
        screen: "/overview",
        state: "default",
        status: "INSPECTED",
        evidenceIds: ["ev_render_overview_06"],
        observations: completeIntentionalObservations().map((observation, index) => index === 0
          ? { ...observation, observedEvidence: [] }
          : observation),
      }],
    })).rejects.toThrow(/observed evidence/i);
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
      approvedGenome: genome as unknown as import("@design-sharingan/governance").GenomeDocument,
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
