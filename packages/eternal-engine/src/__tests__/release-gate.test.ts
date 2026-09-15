import { describe, expect, it } from "vitest";
import { evaluateReleaseGate } from "../release-gate";

const verifiedAt = "2026-08-31T12:00:00.000Z";
const sourceRevisionFingerprint = "a".repeat(64);
const wholeProductScope = {
  requestedScope: "WHOLE_APP" as const,
  expectedScope: [
    { screen: "/overview", states: ["default", "loading", "error"] },
    { screen: "/reports", states: ["default"] },
  ],
  inspectedScope: [
    "/overview#default",
    "/overview#loading",
    "/overview#error",
    "/reports#default",
  ],
  unavailableScope: [],
};
const stateRenderEvidence = [
  { route: "/overview", state: "default", requiredId: "ev_states_01", freshId: "ev_render_01" },
  { route: "/overview", state: "loading", requiredId: "ev_states_loading_01", freshId: "ev_render_loading_01" },
  { route: "/overview", state: "error", requiredId: "ev_states_error_01", freshId: "ev_render_error_01" },
  { route: "/reports", state: "default", requiredId: "ev_states_reports_01", freshId: "ev_render_reports_01" },
];

function checkedInput() {
  return {
    scope: wholeProductScope,
    navigation: "PASS" as const,
    accessibility: "PASS" as const,
    criticalDrift: "PASS" as const,
    newDesignRules: "PASS" as const,
    screenRegistration: "PASS" as const,
    requiredStates: "PASS" as const,
    freshRenders: "PASS" as const,
    decisions: "PASS" as const,
    functionalVerification: "PASS" as const,
    evidence: {
      navigation: { evidence: ["ev_navigation_01"], lastVerified: verifiedAt },
      accessibility: { evidence: ["ev_accessibility_01"], lastVerified: verifiedAt },
      criticalDrift: { evidence: ["ev_drift_01"], lastVerified: verifiedAt },
      newDesignRules: { evidence: ["ev_decisions_01"], lastVerified: verifiedAt },
      screenRegistration: { evidence: ["ev_registry_01"], lastVerified: verifiedAt },
      requiredStates: { evidence: stateRenderEvidence.map(({ requiredId }) => requiredId), lastVerified: verifiedAt },
      freshRenders: { evidence: stateRenderEvidence.map(({ freshId }) => freshId), lastVerified: verifiedAt },
      decisions: { evidence: ["ev_decisions_01"], lastVerified: verifiedAt },
      functionalVerification: { evidence: ["ev_functional_01"], lastVerified: verifiedAt },
    },
    projectId: "project-a",
    currentSourceRevisionFingerprint: sourceRevisionFingerprint,
    authenticatedEvidence: [...[
      "ev_navigation_01",
      "ev_accessibility_01",
      "ev_drift_01",
      "ev_decisions_01",
      "ev_registry_01",
      "ev_functional_01",
    ].map((id) => ({
      id,
      projectId: "project-a",
      route: "/overview",
      state: "default",
      kind: "EVIDENCE" as const,
      capturedAt: verifiedAt,
      sourceRevisionFingerprint,
    })), ...stateRenderEvidence.flatMap(({ route, state, requiredId, freshId }) => [
      {
        id: requiredId,
        projectId: "project-a",
        route,
        state,
        kind: "RENDER" as const,
        capturedAt: verifiedAt,
        sourceRevisionFingerprint,
      },
      {
        id: freshId,
        projectId: "project-a",
        route,
        state,
        kind: "RENDER" as const,
        capturedAt: verifiedAt,
        sourceRevisionFingerprint,
      },
    ])],
  };
}

describe("Release gate", () => {
  // Production break: sequential real captures can never pass because every render is required to have an identical timestamp.
  it("accepts independently captured fresh states at the exact latest verification timestamp", () => {
    const input = checkedInput();
    input.authenticatedEvidence[0]!.capturedAt = "2026-08-31T11:59:58.000Z";
    input.authenticatedEvidence.find((entry) => entry.id === "ev_render_01")!.capturedAt = "2026-08-31T11:59:59.000Z";
    expect(evaluateReleaseGate(input).status).toBe("PASS");
    input.authenticatedEvidence[0]!.capturedAt = "2026-08-31T12:00:01.000Z";
    expect(evaluateReleaseGate(input).status).toBe("NOT_VERIFIED");
  });
  it("blocks PASS when final render evidence is stale", () => {
    const result = evaluateReleaseGate({
      navigation: "PASS",
      accessibility: "PASS",
      criticalDrift: "PASS",
      newDesignRules: "PASS",
      screenRegistration: "PASS",
      requiredStates: "PASS",
      freshRenders: "FAIL",
      decisions: "PASS",
      functionalVerification: "PASS",
    });

    expect(result.status).toBe("NOT_VERIFIED");
    expect(result.checks.find(({ name }) => name === "freshRenders")?.blockingReason)
      .toMatch(/fresh render/i);
  });

  it("cannot PASS when required states are missing even if no critical drift is known", () => {
    const result = evaluateReleaseGate({
      ...checkedInput(),
      requiredStates: "FAIL",
      evidence: {
        ...checkedInput().evidence,
        requiredStates: {
          evidence: [],
          blockingReason: "The error state has no authenticated render.",
        },
      },
    });

    expect(result.status).toBe("NOT_VERIFIED");
  });

  it("returns PASS_WITH_DEBT only for documented non-blocking polish debt", () => {
    const result = evaluateReleaseGate({
      ...checkedInput(),
      polishDebt: [{
        finding: "Align the lower divider to the shared inset token.",
        rationale: "The offset is visible but does not affect task completion or accessibility.",
      documentedBy: "design-decision-42",
      evidenceIds: ["ev_polish_01"],
    }],
    approvedDecisionIds: ["design-decision-42"],
    unresolvedFindings: [{
      finding: "Align the lower divider to the shared inset token.",
      severity: "POLISH",
      evidenceIds: ["ev_polish_01"],
    }],
    authenticatedEvidence: [
      ...checkedInput().authenticatedEvidence,
      {
        id: "ev_polish_01",
        projectId: "project-a",
        route: "/overview",
        state: "default",
        kind: "EVIDENCE",
        capturedAt: verifiedAt,
        sourceRevisionFingerprint,
        findingCategory: "POLISH",
      },
    ],
    });

    expect(result.status).toBe("PASS_WITH_DEBT");
    expect(result.nonBlockingDebt).toHaveLength(1);
  });

  it("returns PASS only when every check, scope member, and evidence record is fresh", () => {
    const result = evaluateReleaseGate(checkedInput());

    expect(result.status).toBe("PASS");
    expect(result.checks).toHaveLength(9);
    expect(result.checks.every(({ evidence, lastVerified }) => evidence.length > 0 && lastVerified === verifiedAt))
      .toBe(true);
  });

  it("does not accept default-only renders as coverage for every required canonical route state", () => {
    const complete = checkedInput();
    const result = evaluateReleaseGate({
      ...complete,
      evidence: {
        ...complete.evidence,
        requiredStates: { evidence: ["ev_states_01"], lastVerified: verifiedAt },
        freshRenders: { evidence: ["ev_render_01"], lastVerified: verifiedAt },
      },
    });

    expect(result.status).toBe("NOT_VERIFIED");
    expect(result.requiredStates).toBe("NOT_VERIFIED");
    expect(result.freshRenders).toBe("NOT_VERIFIED");
  });

  it("never treats bare PASS strings as release evidence or partial evidence as whole-product coverage", () => {
    const bare = evaluateReleaseGate({
      navigation: "PASS",
      accessibility: "PASS",
      criticalDrift: "PASS",
      newDesignRules: "PASS",
      screenRegistration: "PASS",
      requiredStates: "PASS",
      freshRenders: "PASS",
      decisions: "PASS",
      functionalVerification: "PASS",
    });
    const partial = evaluateReleaseGate({
      ...checkedInput(),
      scope: {
        ...wholeProductScope,
        inspectedScope: ["/overview#default"],
      },
    });

    expect(bare.status).toBe("NOT_VERIFIED");
    expect(partial.status).toBe("NOT_VERIFIED");
  });

  it("never releases a one-screen audit as a whole-product PASS", () => {
    const result = evaluateReleaseGate({
      ...checkedInput(),
      scope: {
        requestedScope: "WHOLE_APP",
        expectedScope: [{ screen: "/overview", states: ["default"] }],
        inspectedScope: ["/overview#default"],
        unavailableScope: [],
      },
    });

    expect(result.status).toBe("NOT_VERIFIED");
  });

  it("requires the exact canonical inspected screen set rather than a superset of rows", () => {
    const result = evaluateReleaseGate({
      ...checkedInput(),
      scope: {
        ...wholeProductScope,
        inspectedScope: [...wholeProductScope.inspectedScope, "/unregistered#default"],
      },
    });

    expect(result.status).toBe("NOT_VERIFIED");
  });

  it("does not count encoded aliases of one route as distinct whole-product screens", () => {
    const result = evaluateReleaseGate({
      ...checkedInput(),
      scope: {
        requestedScope: "WHOLE_APP",
        expectedScope: [
          { screen: "/overview", states: ["default"] },
          { screen: "/over%76iew", states: ["default"] },
        ],
        inspectedScope: ["/overview#default", "/over%76iew#default"],
        unavailableScope: [],
      },
    });

    expect(result.status).toBe("NOT_VERIFIED");
  });

  it("blocks release when a known critical regression is unresolved", () => {
    const result = evaluateReleaseGate({
      ...checkedInput(),
      criticalDrift: "FAIL",
      evidence: {
        ...checkedInput().evidence,
        criticalDrift: {
          evidence: ["ev_drift_critical_01"],
          lastVerified: verifiedAt,
          blockingReason: "Primary navigation task completion is broken.",
        },
      },
    });

    expect(result.status).toBe("BLOCKED");
  });

  it("does not trust forged or non-canonical verification times as release evidence", () => {
    const result = evaluateReleaseGate({
      ...checkedInput(),
      evidence: {
        ...checkedInput().evidence,
        freshRenders: {
          evidence: ["ev_render_01"],
          lastVerified: "2026-08-31T12:00:00Z",
        },
      },
    });

    expect(result.status).toBe("NOT_VERIFIED");
    expect(result.checks.find(({ name }) => name === "freshRenders")?.status).toBe("NOT_VERIFIED");
  });

  it("fails closed rather than throwing when a verification timestamp is malformed", () => {
    const input = {
      ...checkedInput(),
      evidence: {
        ...checkedInput().evidence,
        freshRenders: { evidence: ["ev_render_01"], lastVerified: "not-a-timestamp" },
      },
    };

    expect(() => evaluateReleaseGate(input)).not.toThrow();
    expect(evaluateReleaseGate(input).status).toBe("NOT_VERIFIED");
  });

  it("does not downgrade non-polish or undocumented residual release failures into debt", () => {
    expect(() => evaluateReleaseGate({
      ...checkedInput(),
      polishDebt: [{
        finding: "Primary navigation is unavailable.",
        rationale: "This is not polish.",
        documentedBy: "unapproved-decision",
        evidenceIds: ["ev_navigation_01"],
      }],
    })).toThrow(/documented decision/i);
  });

  it("does not treat a catalog-bound polish item as the sole residual issue when an important finding remains", () => {
    const input = {
      ...checkedInput(),
      polishDebt: [{
        finding: "Align the lower divider to the shared inset token.",
        rationale: "The offset is visible but does not affect task completion or accessibility.",
        documentedBy: "design-decision-42",
        evidenceIds: ["ev_polish_01"],
      }],
      approvedDecisionIds: ["design-decision-42"],
      authenticatedEvidence: [
        ...checkedInput().authenticatedEvidence,
        {
          id: "ev_polish_01",
          projectId: "project-a",
          route: "/overview",
          state: "default",
          kind: "EVIDENCE" as const,
          capturedAt: verifiedAt,
          sourceRevisionFingerprint,
          findingCategory: "POLISH" as const,
        },
      ],
      unresolvedFindings: [
        { finding: "Align the lower divider to the shared inset token.", severity: "POLISH" as const, evidenceIds: ["ev_polish_01"] },
        { finding: "The primary action no longer exposes the approved decision path.", severity: "IMPORTANT" as const, evidenceIds: ["ev_navigation_01"] },
      ],
    };

    expect(() => evaluateReleaseGate(input)).toThrow(/sole residual|polish/i);
  });

  it("does not PASS when a server-derived unresolved finding has no documented debt path", () => {
    const result = evaluateReleaseGate({
      ...checkedInput(),
      unresolvedFindings: [{
        finding: "The primary action no longer exposes the approved decision path.",
        severity: "IMPORTANT",
        evidenceIds: ["ev_navigation_01"],
      }],
    });

    expect(result.status).toBe("NOT_VERIFIED");
  });

  it("does not PASS when a catalog ID is forged or its final render belongs to an older source revision", () => {
    const forged = evaluateReleaseGate({
      ...checkedInput(),
      evidence: {
        ...checkedInput().evidence,
        freshRenders: { evidence: ["ev_not_in_catalog_01"], lastVerified: verifiedAt },
      },
    });
    const staleSource = evaluateReleaseGate({
      ...checkedInput(),
      currentSourceRevisionFingerprint: "b".repeat(64),
    });

    expect(forged.status).toBe("NOT_VERIFIED");
    expect(staleSource.status).toBe("NOT_VERIFIED");
  });
});
