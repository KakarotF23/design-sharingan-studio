import { describe, expect, it } from "vitest";
import { evaluateReleaseGate } from "../release-gate";

const verifiedAt = "2026-08-31T12:00:00.000Z";
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
      requiredStates: { evidence: ["ev_states_01"], lastVerified: verifiedAt },
      freshRenders: { evidence: ["ev_render_01"], lastVerified: verifiedAt },
      decisions: { evidence: ["ev_decisions_01"], lastVerified: verifiedAt },
      functionalVerification: { evidence: ["ev_functional_01"], lastVerified: verifiedAt },
    },
  };
}

describe("Release gate", () => {
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
      }],
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
});
