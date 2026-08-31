import { evaluateReleaseGate } from "../../packages/eternal-engine/src/release-gate";
import { expect, test } from "@playwright/test";

const verifiedAt = "2026-08-31T12:00:00.000Z";
const checks = {
  navigation: "PASS" as const,
  accessibility: "PASS" as const,
  criticalDrift: "PASS" as const,
  newDesignRules: "PASS" as const,
  screenRegistration: "PASS" as const,
  requiredStates: "PASS" as const,
  freshRenders: "PASS" as const,
  decisions: "PASS" as const,
  functionalVerification: "PASS" as const,
};
const evidence = Object.fromEntries(Object.keys(checks).map((name) => [name, {
  evidence: [`ev_${name}_01`],
  lastVerified: verifiedAt,
}])) as Parameters<typeof evaluateReleaseGate>[0]["evidence"];
const scope = {
  requestedScope: "WHOLE_APP" as const,
  expectedScope: [
    { screen: "/overview", states: ["default", "loading", "error"] },
    { screen: "/reports", states: ["default"] },
  ],
  inspectedScope: ["/overview#default", "/overview#loading", "/overview#error", "/reports#default"],
  unavailableScope: [],
};

test("does not release a no-critical-drift audit when a required state has no render", () => {
  expect(evaluateReleaseGate({
    ...checks,
    scope,
    requiredStates: "FAIL",
    evidence: { ...evidence, requiredStates: { evidence: [], blockingReason: "Loading state is unavailable." } },
  }).status).toBe("NOT_VERIFIED");
});

test("classifies documented polish debt as PASS_WITH_DEBT", () => {
  expect(evaluateReleaseGate({
    ...checks,
    scope,
    evidence,
    polishDebt: [{
      finding: "Align the lower divider to the shared inset token.",
      rationale: "The discrepancy is non-blocking visual polish.",
      documentedBy: "design-decision-42",
    }],
  }).status).toBe("PASS_WITH_DEBT");
});

test("requires complete fresh evidence for PASS", () => {
  expect(evaluateReleaseGate({ ...checks, scope, evidence }).status).toBe("PASS");
});
