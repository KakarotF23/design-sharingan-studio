import { describe, expect, it } from "vitest";

import { evaluateStopCriteria } from "../stop-criteria";

describe("evaluateStopCriteria", () => {
  it("stops when critical findings are zero and final evidence is fresh", () => {
    expect(
      evaluateStopCriteria({
        round: 3,
        maxRounds: 5,
        criticalCount: 0,
        importantCount: 1,
        importantThreshold: 2,
        uxRegressions: 0,
        genomeConflicts: 0,
        hasFreshFinalRender: true
      }).stop
    ).toBe(true);
  });

  it("never passes without fresh final render", () => {
    expect(
      evaluateStopCriteria({
        round: 3,
        maxRounds: 5,
        criticalCount: 0,
        importantCount: 0,
        importantThreshold: 2,
        uxRegressions: 0,
        genomeConflicts: 0,
        hasFreshFinalRender: false
      }).reason
    ).toMatch(/fresh render/i);
  });

  it("stops truthfully at the iteration budget without reporting a pass", () => {
    expect(
      evaluateStopCriteria({
        round: 5,
        maxRounds: 5,
        criticalCount: 1,
        importantCount: 0,
        importantThreshold: 2,
        uxRegressions: 0,
        genomeConflicts: 0,
        hasFreshFinalRender: true
      }),
    ).toEqual({
      stop: true,
      pass: false,
      outcome: "MAX_ROUNDS",
      reason: "Maximum visual round budget reached before quality criteria passed."
    });
  });

  it.each([
    ["build failure", { buildFailed: true }, "BUILD_FAILED"],
    ["user stop", { userStopped: true }, "USER_STOPPED"],
    ["human gate", { humanGatePending: true }, "HUMAN_GATE"]
  ] as const)("gives %s deterministic precedence over model-quality metrics", (_label, state, outcome) => {
    expect(
      evaluateStopCriteria({
        round: 1,
        maxRounds: 5,
        criticalCount: 0,
        importantCount: 0,
        importantThreshold: 2,
        uxRegressions: 0,
        genomeConflicts: 0,
        hasFreshFinalRender: true,
        ...state
      }),
    ).toMatchObject({ stop: true, pass: false, outcome });
  });

  it("does not infer whole-product completion from one inspected route", () => {
    expect(
      evaluateStopCriteria({
        round: 2,
        maxRounds: 5,
        criticalCount: 0,
        importantCount: 0,
        importantThreshold: 2,
        uxRegressions: 0,
        genomeConflicts: 0,
        hasFreshFinalRender: true,
        claimedScreens: ["/", "/settings"],
        inspectedScreens: ["/"]
      }),
    ).toMatchObject({ stop: false, pass: false, outcome: "CONTINUE" });
  });
});
