import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DriftView } from "./drift-view";

// Production break caught: legitimate polish findings cannot be documented as debt in the UI, while resolved findings are offered as executable work.
it("offers an explicit rationale and approval only for open non-consequential polish debt", () => {
  const finding = { scope: "/#default", category: "POLISH" as const, severity: "POLISH" as const, expectedRule: "Refine spacing", observedEvidence: ["Small spacing inconsistency"], evidenceIds: ["ev_polish_01"], genomeRuleId: "rule-spacing", whyItMatters: "Minor scan rhythm", recommendedFix: "Align the gap", requiresDesignDecision: false, status: "OPEN" as const, handoffKey: "a".repeat(64) };
  const report = { requestedScope: "SELECTED_SCREENS" as const, expectedScope: [{ screen: "/", states: ["default"] }], inspectedScope: ["/#default"], unavailableScope: [], unverifiedScope: [], evidenceIds: finding.evidenceIds, findings: [finding], overallStatus: "PASS_WITH_DEBT" as const };
  const render = (value: typeof report) => renderToStaticMarkup(React.createElement(DriftView, { report: value, busy: false, onAudit() {}, executeHref: "/projects/project-1/execute", onApproveDebt: async () => undefined }));
  expect(render(report)).toContain("Approve documented polish debt");
  expect(render(report)).toContain("Why is this safe to defer?");
  expect(render({ ...report, findings: [{ ...finding, status: "RESOLVED" as never }] })).not.toContain("Send to Execute");
});
