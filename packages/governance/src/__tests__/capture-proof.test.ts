import type { GovernanceCaptureSession } from "@design-sharingan/project-adapters";
import { expect, it } from "vitest";
import { captureFullyVerified } from "../capture-proof";

// Production break caught: inconsistent all-PASS check labels can hide an explicit Critical/Important finding in the same authenticated visual proof.
it("never calls a capture fully verified when its visual analysis retains a blocking finding", () => {
  const pass = { status: "PASS" as const, evidence: ["Observed"] };
  const proof = { verifiedCategories: Array.from({ length: 7 }, () => ({ category: "HIERARCHY", evidence: ["Observed"] })), browserChecks: { navigation: "PASS", accessibility: "PASS", functionalVerification: "PASS", evidence: ["Observed"] }, analysis: { threadId: "t", verification: { uxIntegrity: pass, productConsistency: pass, accessibility: pass, genomeIntegrity: pass }, findings: [{ id: "critical", severity: "CRITICAL", category: "ACCESSIBILITY", screen: "/", description: "Primary task is inaccessible", reason: "Unreadable control", recommendedAction: "Fix contrast", evidence: ["Unreadable text"], status: "OPEN" }] } } as Pick<GovernanceCaptureSession, "verifiedCategories" | "browserChecks" | "analysis">;
  expect(captureFullyVerified(proof)).toBe(false);
});
