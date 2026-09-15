import { expect, it } from "vitest";
import { deriveDocumentedPolishDebt } from "../finding-handoff";

// Production break caught: accepting one polish decision while Important work remains can make the entire Govern projection throw, or incorrectly present the incomplete set as release debt.
it("derives release debt only from the complete set of signed, non-consequential polish decisions", () => {
  const finding = { scope: "/#default", expectedRule: "Refine spacing", severity: "POLISH" as const, status: "OPEN" as const, requiresDesignDecision: false, evidenceIds: ["ev_polish_01"] };
  const decision = { id: "debt-1", status: "APPROVED" as const, approvedBy: "local-user" as const, decision: "Accept polish debt: /#default: Refine spacing", reason: "Minor visual alignment is safe to track.", migrationRequired: false, genomeChanges: [] };
  expect(deriveDocumentedPolishDebt([finding], [decision])).toEqual([{ finding: "/#default: Refine spacing", rationale: decision.reason, documentedBy: decision.id, evidenceIds: finding.evidenceIds }]);
  expect(deriveDocumentedPolishDebt([finding, { ...finding, severity: "IMPORTANT" }], [decision])).toEqual([]);
  expect(deriveDocumentedPolishDebt([finding], [{ ...decision, status: "DRAFT" }])).toEqual([]);
});
