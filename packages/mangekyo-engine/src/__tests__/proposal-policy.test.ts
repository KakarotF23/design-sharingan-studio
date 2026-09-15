import type { ChangeProposal } from "@design-sharingan/core";
import { describe, expect, it } from "vitest";

import { classifyProposalChange } from "../proposal-policy";

function proposal(overrides: Partial<ChangeProposal> = {}): ChangeProposal {
  return {
    id: "proposal-1",
    sessionId: "mangekyo-1",
    summary: "One visual objective",
    reason: "Inspect the rendered evidence.",
    filesToCreate: [],
    filesToModify: ["styles.css"],
    filesToDelete: [],
    componentsAffected: ["Surface"],
    screensAffected: ["/"],
    uxImpact: [{
      area: "Surface",
      severity: "IMPORTANT",
      reason: "Improve hierarchy.",
      affectedRoutes: ["/"],
      affectedComponents: ["Surface"],
      decisionRequired: false,
    }],
    visualImpact: "Improves hierarchy.",
    riskLevel: "LOW",
    requiresHumanApproval: true,
    policyViolations: [],
    status: "PROPOSED",
    ...overrides,
  };
}

describe("classifyProposalChange", () => {
  it("allows only unambiguous stylesheet changes and fails a mislabeled code edit closed", () => {
    expect(classifyProposalChange(proposal())).toEqual({
      kind: "STYLE_CHANGE",
      files: ["styles.css"],
    });
    expect(classifyProposalChange(proposal({
      filesToModify: ["server.mjs"],
      policyViolations: ["STYLE_CHANGE"],
    }))).toEqual({
      kind: "NAVIGATION_CHANGE",
      files: ["server.mjs"],
    });
  });

  it("preserves deterministic high-risk deletion and dependency gates", () => {
    expect(classifyProposalChange(proposal({
      filesToModify: [],
      filesToDelete: ["styles.css"],
    })).kind).toBe("FILE_DELETION");
    expect(classifyProposalChange(proposal({
      filesToModify: ["package.json"],
    })).kind).toBe("DEPENDENCY_INSTALL");
  });
});
