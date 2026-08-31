import { evaluateReleaseGate } from "../../packages/eternal-engine/src/release-gate";
import { expect, test } from "@playwright/test";

const verifiedAt = "2026-08-31T12:00:00.000Z";
const sourceRevisionFingerprint = "a".repeat(64);
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
const stateRenderEvidence = [
  { route: "/overview", state: "default", requiredId: "ev_requiredStates_01", freshId: "ev_freshRenders_01" },
  { route: "/overview", state: "loading", requiredId: "ev_requiredStates_loading_01", freshId: "ev_freshRenders_loading_01" },
  { route: "/overview", state: "error", requiredId: "ev_requiredStates_error_01", freshId: "ev_freshRenders_error_01" },
  { route: "/reports", state: "default", requiredId: "ev_requiredStates_reports_01", freshId: "ev_freshRenders_reports_01" },
];
const evidence = {
  ...Object.fromEntries(Object.keys(checks).map((name) => [name, {
  evidence: [`ev_${name}_01`],
  lastVerified: verifiedAt,
  }])),
  requiredStates: { evidence: stateRenderEvidence.map(({ requiredId }) => requiredId), lastVerified: verifiedAt },
  freshRenders: { evidence: stateRenderEvidence.map(({ freshId }) => freshId), lastVerified: verifiedAt },
} as Parameters<typeof evaluateReleaseGate>[0]["evidence"];
const authenticatedEvidence = Object.keys(checks)
  .filter((name) => name !== "requiredStates" && name !== "freshRenders")
  .map((name) => ({
  id: `ev_${name}_01`,
  projectId: "project-a",
  route: "/overview",
  state: "default",
  kind: "EVIDENCE" as const,
  capturedAt: verifiedAt,
  sourceRevisionFingerprint,
})).concat(stateRenderEvidence.flatMap(({ route, state, requiredId, freshId }) => [
  { id: requiredId, projectId: "project-a", route, state, kind: "RENDER" as const, capturedAt: verifiedAt, sourceRevisionFingerprint },
  { id: freshId, projectId: "project-a", route, state, kind: "RENDER" as const, capturedAt: verifiedAt, sourceRevisionFingerprint },
]));
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
    projectId: "project-a",
    currentSourceRevisionFingerprint: sourceRevisionFingerprint,
    authenticatedEvidence,
  }).status).toBe("NOT_VERIFIED");
});

test("classifies documented polish debt as PASS_WITH_DEBT", () => {
  expect(evaluateReleaseGate({
    ...checks,
    scope,
    evidence,
    projectId: "project-a",
    currentSourceRevisionFingerprint: sourceRevisionFingerprint,
    authenticatedEvidence: [...authenticatedEvidence, {
      id: "ev_polish_01", projectId: "project-a", route: "/overview", state: "default",
      kind: "EVIDENCE" as const, capturedAt: verifiedAt, sourceRevisionFingerprint, findingCategory: "POLISH" as const,
    }],
    approvedDecisionIds: ["design-decision-42"],
    unresolvedFindings: [{
      finding: "Align the lower divider to the shared inset token.",
      severity: "POLISH",
      evidenceIds: ["ev_polish_01"],
    }],
    polishDebt: [{
      finding: "Align the lower divider to the shared inset token.",
      rationale: "The discrepancy is non-blocking visual polish.",
      documentedBy: "design-decision-42",
      evidenceIds: ["ev_polish_01"],
    }],
  }).status).toBe("PASS_WITH_DEBT");
});

test("requires complete fresh evidence for PASS", () => {
  expect(evaluateReleaseGate({
    ...checks,
    scope,
    evidence,
    projectId: "project-a",
    currentSourceRevisionFingerprint: sourceRevisionFingerprint,
    authenticatedEvidence,
  }).status).toBe("PASS");
});

test("does not let default-only render identities cover loading, error, or another route", () => {
  expect(evaluateReleaseGate({
    ...checks,
    scope,
    evidence: {
      ...evidence,
      requiredStates: { evidence: ["ev_requiredStates_01"], lastVerified: verifiedAt },
      freshRenders: { evidence: ["ev_freshRenders_01"], lastVerified: verifiedAt },
    },
    projectId: "project-a",
    currentSourceRevisionFingerprint: sourceRevisionFingerprint,
    authenticatedEvidence,
  }).status).toBe("NOT_VERIFIED");
});
